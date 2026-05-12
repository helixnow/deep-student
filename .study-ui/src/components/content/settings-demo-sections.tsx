import { type ReactNode, useState } from "react";
import {
  Bell,
  CalendarDots,
  Cards,
  CaretDown,
  ChatCircleText,
  CheckCircle,
  CircleNotch,
  DotsThreeOutlineVertical,
  Info,
  Layout,
  MagicWand,
  MagnifyingGlass,
  Plus,
  Question,
  SidebarSimple,
  WarningCircle,
} from "@phosphor-icons/react";

import { Sidebar as AppSidebar } from "@/components/shell/Sidebar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Surface } from "@/components/ui/surface";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { stateRegressionChecklist, workspaceSelectOptions } from "@/components/content/settings-demo-data";
import { cn } from "@/lib/utils";

const surfaceBorderClassName = "border-border/70";
const demoShellPreviewClassName = "overflow-hidden rounded-3xl border border-shell-rim/70 bg-shell-panel/92 shadow-sm shadow-black/5";
const demoBadgeClassName =
  "inline-flex w-fit items-center rounded-full border border-border/60 bg-background/90 px-2.5 py-1 text-xs font-medium text-muted-foreground";

const typographySizeSamples = [
  {
    label: "Display",
    sizeLabel: "32px",
    className: "text-[2rem] font-semibold",
    usage: "页面主标题、强层级入口。",
  },
  {
    label: "Title",
    sizeLabel: "24px",
    className: "text-2xl font-semibold",
    usage: "卡片标题、模块切换标题。",
  },
  {
    label: "Body",
    sizeLabel: "16px",
    className: "text-base font-normal",
    usage: "正文、说明和大多数输入内容。",
  },
  {
    label: "Caption",
    sizeLabel: "14px",
    className: "text-sm font-normal",
    usage: "辅助说明、状态补充、弱提示。",
  },
] as const;

const typographyWeightSamples = [
  {
    label: "Regular",
    weight: 400,
    className: "font-normal",
    usage: "正文、说明和长段落默认使用。",
  },
  {
    label: "Medium",
    weight: 500,
    className: "font-medium",
    usage: "用于表单标签、次级强调和列表标题。",
  },
  {
    label: "Semibold",
    weight: 600,
    className: "font-semibold",
    usage: "适合卡片标题、统计值和强层级信息。",
  },
  {
    label: "Bold",
    weight: 700,
    className: "font-bold",
    usage: "只留给关键数字或极少量强提醒。",
  },
] as const;

export type DemoSectionCardProps = {
  title: string;
  description: string;
  className?: string;
  children: ReactNode;
};

export type SidebarPreviewItem = {
  id: string;
  label: string;
  icon: ReactNode;
};

export type SidebarPreviewFolder = {
  id: string;
  label: string;
  icon: ReactNode;
  active: boolean;
  count: number;
};

export type SidebarPreviewThread = {
  id: number | string;
  title: string;
  active: boolean;
  meta?: string;
  folderId: string;
  pinned?: boolean;
};

type SelectComboboxSectionProps = {
  suggestions: readonly string[];
};

type SidebarPreviewSectionProps = {
  folderItems: SidebarPreviewFolder[];
  settingsNavItems: SidebarPreviewItem[];
  threadItems: SidebarPreviewThread[];
};

type FeedbackPatternsSectionProps = {
  title: string;
  description: string;
  className?: string;
  toastVisible: boolean;
  onShowToast: () => void;
};

type StateRegressionSectionProps = {
  title: string;
  description: string;
  className?: string;
};

type TypographySectionProps = {
  title: string;
  description: string;
  className?: string;
};

type ShowcaseSectionProps = {
  title: string;
  description: string;
  className?: string;
};

function StateBadge({ label }: { label: string }) {
  return (
    <div className={demoBadgeClassName}>
      {label}
    </div>
  );
}

function SkeletonBlock({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-xl bg-interactive-hover", className)} />;
}

function ListItemPreview({ title, meta, active = false }: { title: string; meta: string; active?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center justify-between rounded-2xl border px-4 py-3 text-left transition-colors shadow-sm shadow-black/5",
        surfaceBorderClassName,
        active ? "bg-interactive-selected" : "bg-secondary/78 hover:bg-interactive-hover",
      )}
    >
      <div className="min-w-0 space-y-1">
        <p className="truncate text-sm font-medium text-foreground">{title}</p>
        <p className="truncate text-xs text-muted-foreground">{meta}</p>
      </div>
      <CheckCircle size={18} className={active ? "text-primary" : "text-muted-foreground"} />
    </button>
  );
}

export function DemoSectionCard({ title, description, className, children }: DemoSectionCardProps) {
  return (
    <Card className={cn("h-full", className)}>
      <CardHeader className="space-y-2">
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function ShowcaseSection({ title, description, className, children }: ShowcaseSectionProps & { children: ReactNode }) {
  return (
    <section className={cn(showcaseFrameClassName, className)}>
      <div className="border-b border-black/6 px-6 py-5 dark:border-white/8">
        <div className="space-y-2">
          <h3 className="text-lg font-semibold text-foreground">{title}</h3>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
        </div>
      </div>

      <div className="px-6 py-6">{children}</div>
    </section>
  );
}

const stateRegressionFrameClassName =
  "overflow-hidden rounded-2xl border border-border/70 bg-background/94 shadow-sm shadow-black/5";

const stateRegressionPanelClassName =
  "rounded-xl border border-border/70 bg-background/92 p-4";

const stateRegressionTileClassName =
  "rounded-xl border border-border/60 bg-secondary/78 px-4 py-3";

const typographyFrameClassName =
  "overflow-hidden rounded-2xl border border-border/70 bg-background/94 shadow-sm shadow-black/5";

const typographyPanelClassName =
  "rounded-xl border border-border/70 bg-background/92 p-4";

const typographyTileClassName =
  "rounded-xl border border-border/60 bg-secondary/78 px-4 py-3";

const feedbackFrameClassName =
  "overflow-hidden rounded-2xl border border-border/70 bg-background/94 shadow-sm shadow-black/5";

const feedbackPanelClassName =
  "rounded-xl border border-border/70 bg-background/92 p-4";

const feedbackTileClassName =
  "rounded-xl border border-border/60 bg-secondary/78 px-4 py-3";

const feedbackToastClassName =
  "w-full rounded-xl border border-border/70 bg-background/92 p-4 shadow-sm shadow-black/5";

const showcaseFrameClassName =
  "overflow-hidden rounded-2xl border border-border/70 bg-background/94 shadow-sm shadow-black/5";

const showcasePanelClassName =
  "rounded-xl border border-border/70 bg-background/92 p-4";

const showcaseTileClassName =
  "rounded-xl border border-border/60 bg-secondary/78 px-4 py-3";

export function StateRegressionSection({ title, description, className }: StateRegressionSectionProps) {
  return (
    <section className={cn(stateRegressionFrameClassName, className)}>
      <div className="border-b border-black/6 px-6 py-5 dark:border-white/8">
        <div className="space-y-2">
          <h3 className="text-lg font-semibold text-foreground">{title}</h3>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
        </div>
      </div>

      <div className="px-6 py-6">
        <div className="grid gap-3 xl:grid-cols-[minmax(0,1.45fr)_minmax(16rem,0.8fr)]">
          <div className="grid gap-3 md:grid-cols-2">
            <div className={cn("space-y-3", stateRegressionPanelClassName)}>
              <StateBadge label="Hover 状态" />
              <div className="flex flex-wrap gap-3">
                <Button>主按钮</Button>
                <Button variant="outline">描边按钮</Button>
              </div>
              <div className="space-y-3">
                <p className="text-sm leading-6 text-muted-foreground">把鼠标移入按钮和列表项，检查 Hover 填充层级是否仍然统一。</p>
                <ListItemPreview title="列表项 Hover 检查" meta="移动到这一行，确认列表 hover 与按钮 hover 不会脱节。" />
              </div>
            </div>

            <div className={cn("space-y-3", stateRegressionPanelClassName)}>
              <StateBadge label="Disabled 状态" />
              <div className="flex flex-wrap gap-3">
                <Button disabled>不可点击</Button>
                <Button disabled variant="outline">
                  已禁用
                </Button>
              </div>
              <div className="space-y-3">
                <Input disabled defaultValue="/archive/frozen" aria-label="禁用路径示例" />
                <Textarea disabled defaultValue="这个区域处于锁定状态，暂时不可编辑。" aria-label="禁用多行输入示例" />
              </div>
              <p className="text-sm leading-6 text-muted-foreground">
                当前示例工作区已冻结，所以按钮与输入框仅用于展示禁用态，不支持编辑或触发。
              </p>
            </div>

            <div className={cn("space-y-3", stateRegressionPanelClassName)}>
              <StateBadge label="Error 状态" />
              <div className="space-y-2">
                <Input
                  aria-invalid="true"
                  defaultValue="/knowledge/missing-folder"
                  className="bg-card ring-2 ring-destructive/20 focus-visible:ring-destructive/35"
                  aria-label="错误输入示例"
                />
                <p className="flex items-center gap-2 text-sm text-destructive">
                  <WarningCircle size={16} />
                  目标目录不存在，请重新选择一个可写路径。
                </p>
              </div>
              <Textarea
                aria-invalid="true"
                defaultValue="提示词中缺少必填变量：{{topic}}"
                className="bg-card ring-2 ring-destructive/20 focus-visible:ring-destructive/35"
                aria-label="错误多行输入示例"
              />
            </div>

            <div className={cn("space-y-3", stateRegressionPanelClassName)}>
              <StateBadge label="Loading 状态" />
              <div className="flex flex-wrap gap-3">
                <Button disabled className="gap-2">
                  <CircleNotch className="size-4 animate-spin" />
                  正在同步
                </Button>
                <Button disabled variant="outline" className="gap-2">
                  <CircleNotch className="size-4 animate-spin" />
                  正在校验
                </Button>
              </div>
              <div className="space-y-2">
                <SkeletonBlock className="h-4 w-20" />
                <SkeletonBlock className="h-10 w-full" />
                <SkeletonBlock className="h-10 w-4/5" />
              </div>
            </div>
          </div>

          <div className={cn("space-y-3", stateRegressionPanelClassName)}>
            <StateBadge label="回归检查建议" />
            <div className="space-y-3 text-sm leading-6 text-muted-foreground">
              <p>每次改 UI primitives、主题 token 或交互样式后，优先检查这四类状态是否还保持一致。</p>
              <div className={cn("space-y-2", stateRegressionTileClassName)}>
                <p className="font-medium text-foreground">回归检查建议</p>
                <ul className="space-y-2 pl-5">
                  {stateRegressionChecklist.map((item) => (
                    <li key={item} className="list-disc">
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function ButtonSection() {
  return (
    <div className="flex flex-wrap gap-3">
      <Button icon={Plus}>新建笔记</Button>
      <Button variant="secondary" icon={MagicWand}>
        生成建议
      </Button>
      <Button variant="outline">次级操作</Button>
      <Button variant="ghost">轻量操作</Button>
      <Button size="icon" variant="outline" aria-label="更多操作">
        <DotsThreeOutlineVertical size={18} />
      </Button>
    </div>
  );
}

export function InputSection() {
  return (
    <div className="space-y-3">
      <div className="relative">
        <MagnifyingGlass className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-9" placeholder="搜索设置项、命令或主题" />
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <Input placeholder="例如：/knowledge/notes" />
        <Button variant="secondary">保存路径</Button>
      </div>
    </div>
  );
}

export function TextareaSection() {
  return <Textarea placeholder="记录使用说明、默认提示词，或补充你想给 AI 的上下文。" />;
}

export function TypographySection({ title, description, className }: TypographySectionProps) {
  return (
    <section className={cn(typographyFrameClassName, className, "[font-family:var(--app-font-family)]")}>
      <div className="border-b border-black/6 px-6 py-5 dark:border-white/8">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-lg font-semibold text-foreground">{title}</h3>
            <span className={demoBadgeClassName}>跟随 `--app-font-family`</span>
          </div>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
        </div>
      </div>

      <div className="space-y-3 px-6 py-6">
        <div className={cn("space-y-3", typographyPanelClassName)}>
          <p className="text-sm leading-6 text-muted-foreground">
            用同一句中英混排文案同时检查字号和字重：Study UI 让阅读层级更稳定，也更容易发现中文字面发虚、英文过黑或尺寸跨度失衡的问题。
          </p>
        </div>

        <div className={cn("space-y-4", typographyPanelClassName)}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-foreground">字号阶梯</p>
              <p className="text-xs text-muted-foreground">统一对比 Display、Title、Body、Caption 四档常用尺寸。</p>
            </div>
            <span className={demoBadgeClassName}>Type Scale</span>
          </div>

          <div className="grid gap-3">
            {typographySizeSamples.map((sample) => (
              <div key={sample.label} className={cn("flex items-start justify-between gap-4", typographyTileClassName)}>
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-foreground">{sample.label}</p>
                    <span className="rounded-full border border-border/60 bg-background/90 px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
                      {sample.sizeLabel}
                    </span>
                  </div>
                  <p className={cn("text-balance text-foreground", sample.className)}>Study UI Typography Scale</p>
                  <p className="text-sm text-muted-foreground">{sample.usage}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {typographyWeightSamples.map((sample) => (
            <div key={sample.weight} className={cn("space-y-3", typographyPanelClassName)}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-foreground">{sample.label}</p>
                  <p className="text-xs text-muted-foreground">{sample.usage}</p>
                </div>
                <span className={demoBadgeClassName}>{sample.weight}</span>
              </div>

              <div className={cn("space-y-1", typographyTileClassName)}>
                <p className={cn("text-lg text-foreground", sample.className)}>组件 Demo 字重预览 Typography Weight</p>
                <p className="text-pretty text-sm text-muted-foreground">
                  Aa Bb Cc 1234567890 - 用于检查标题、正文和数字在不同字重下的节奏。
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function SwitchSection() {
  const [desktopNotificationsEnabled, setDesktopNotificationsEnabled] = useState(true);
  const [focusModeEnabled, setFocusModeEnabled] = useState(false);

  return (
    <div className="space-y-3">
      <Surface className="space-y-3 rounded-2xl">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">桌面通知</p>
            <p className="text-sm text-muted-foreground">收到同步结果、批改完成或长任务结束时，允许系统提醒你。</p>
          </div>
          <Switch aria-label="切换桌面通知" checked={desktopNotificationsEnabled} onCheckedChange={setDesktopNotificationsEnabled} />
        </div>

        <div className="flex items-start justify-between gap-4 rounded-2xl border border-border/70 bg-secondary/78 px-4 py-3 shadow-sm shadow-black/5">
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">专注模式</p>
            <p className="text-sm text-muted-foreground">隐藏次级提示和弱提醒，只保留当前任务最关键的信息。</p>
          </div>
          <Switch aria-label="切换专注模式" checked={focusModeEnabled} onCheckedChange={setFocusModeEnabled} />
        </div>
      </Surface>

      <Surface className="flex items-start justify-between gap-4 rounded-2xl">
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">启动时自动同步</p>
          <p className="text-sm text-muted-foreground">演示禁用态，适合检查开关在只读设置下的可读性。</p>
          <p className="text-sm text-muted-foreground">
            演示区固定沿用最近一次成功同步的启动配置，因此这里暂时锁定为开启。
          </p>
        </div>
        <Switch aria-label="启动时自动同步" checked disabled />
      </Surface>
    </div>
  );
}

export function SelectComboboxSection({ suggestions }: SelectComboboxSectionProps) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-2">
        <label htmlFor="demo-workspace-select" className="text-sm font-medium text-foreground">
          Select
        </label>
        <div className="relative">
          <select
            id="demo-workspace-select"
            aria-label="选择默认工作区"
            className="h-10 w-full appearance-none rounded-xl bg-input px-3 pr-10 text-sm text-foreground outline-none transition-[background-color,box-shadow] focus-visible:bg-card focus-visible:ring-2 focus-visible:ring-ring"
            defaultValue="knowledge"
          >
            {workspaceSelectOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <CaretDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        </div>
      </div>

      <div className="space-y-2">
        <label htmlFor="demo-combobox-input" className="text-sm font-medium text-foreground">
          Combobox
        </label>
        <Input id="demo-combobox-input" aria-label="快速命令建议" list="demo-combobox-options" placeholder="输入一个命令或页面名" />
        <datalist id="demo-combobox-options">
          {suggestions.map((item) => (
            <option key={item} value={item} />
          ))}
        </datalist>
      </div>
    </div>
  );
}

export function DialogSection({ title, description, className }: ShowcaseSectionProps) {
  return (
    <ShowcaseSection title={title} description={description} className={className}>
      <div className="space-y-3">
        <div className={cn("space-y-3", showcasePanelClassName)}>
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline" icon={ChatCircleText}>
                打开 Dialog
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>确认保存本次面板配置</DialogTitle>
                <DialogDescription>
                  这个 Dialog 用于展示聚焦式交互：标题、说明、主要操作和次级操作都集中在一个上下文里。
                </DialogDescription>
              </DialogHeader>
              <div className={cn("space-y-1", showcaseTileClassName)}>
                <p className="text-sm font-medium text-foreground">即将保存</p>
                <p className="text-sm text-muted-foreground">主题跟随系统、窗口背景半透明、默认工作区 Knowledge。</p>
              </div>
              <DialogFooter>
                <Button variant="ghost">稍后再说</Button>
                <Button>立即保存</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <p className="text-sm text-muted-foreground">点击按钮体验弹层、遮罩和操作布局。</p>
        </div>
      </div>
    </ShowcaseSection>
  );
}

export function SheetSection({ title, description, className }: ShowcaseSectionProps) {
  return (
    <ShowcaseSection title={title} description={description} className={className}>
      <div className="grid gap-3 md:grid-cols-2">
        <div className={cn("space-y-3", showcasePanelClassName)}>
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="outline" icon={Layout}>
                打开 Sheet
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="flex flex-col gap-5">
              <SheetHeader>
                <SheetTitle>桌面侧滑面板</SheetTitle>
                <SheetDescription>适合在不离开当前页面的前提下，补充更多配置内容。</SheetDescription>
              </SheetHeader>
              <div className="space-y-3">
                <Input placeholder="面板标题" defaultValue="阅读模式" />
                <Textarea defaultValue="在侧滑面板中维护文档宽度、字体和边距。" />
              </div>
              <SheetFooter>
                <Button variant="ghost">取消</Button>
                <Button>保存布局</Button>
              </SheetFooter>
            </SheetContent>
          </Sheet>
          <div className={cn("space-y-1", showcaseTileClassName)}>
            <p className="text-sm font-medium text-foreground">桌面侧滑预览</p>
            <p className="text-sm text-muted-foreground">适合补充设置项、检查输入控件和操作区的排列节奏。</p>
          </div>
        </div>

        <div className={cn("space-y-3", showcasePanelClassName)}>
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="secondary" icon={CalendarDots}>
                打开 Drawer
              </Button>
            </SheetTrigger>
            <SheetContent side="bottom" className="mx-auto w-full max-w-3xl rounded-t-[28px]">
              <SheetHeader>
                <SheetTitle>移动端底部抽屉</SheetTitle>
                <SheetDescription>当纵向空间更紧时，Drawer 更适合承载分段式内容。</SheetDescription>
              </SheetHeader>
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <Surface className="rounded-2xl px-4 py-3">
                  <p className="text-sm font-medium text-foreground">同步</p>
                  <p className="mt-1 text-xs text-muted-foreground">最近 2 分钟</p>
                </Surface>
                <Surface className="rounded-2xl px-4 py-3">
                  <p className="text-sm font-medium text-foreground">缓存</p>
                  <p className="mt-1 text-xs text-muted-foreground">42 MB</p>
                </Surface>
                <Surface className="rounded-2xl px-4 py-3">
                  <p className="text-sm font-medium text-foreground">队列</p>
                  <p className="mt-1 text-xs text-muted-foreground">3 个任务</p>
                </Surface>
              </div>
            </SheetContent>
          </Sheet>
          <div className={cn("grid gap-2 sm:grid-cols-3", showcaseTileClassName)}>
            <div>
              <p className="text-sm font-medium text-foreground">同步</p>
              <p className="mt-1 text-xs text-muted-foreground">最近 2 分钟</p>
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">缓存</p>
              <p className="mt-1 text-xs text-muted-foreground">42 MB</p>
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">队列</p>
              <p className="mt-1 text-xs text-muted-foreground">3 个任务</p>
            </div>
          </div>
        </div>
      </div>
    </ShowcaseSection>
  );
}

export function TabsSection() {
  return (
    <Tabs defaultValue="overview">
      <TabsList>
        <TabsTrigger value="overview">总览</TabsTrigger>
        <TabsTrigger value="states">状态</TabsTrigger>
        <TabsTrigger value="notes">备注</TabsTrigger>
      </TabsList>
      <TabsContent value="overview">
        <Surface className="rounded-2xl">
          <p className="text-sm font-medium text-foreground">总览视图</p>
          <p className="mt-1 text-sm text-muted-foreground">适合放摘要、统计和页面说明。</p>
        </Surface>
      </TabsContent>
      <TabsContent value="states">
        <Surface className="rounded-2xl">
          <p className="text-sm font-medium text-foreground">状态视图</p>
          <p className="mt-1 text-sm text-muted-foreground">可以并排展示空态、加载态和已完成态。</p>
        </Surface>
      </TabsContent>
      <TabsContent value="notes">
        <Surface className="rounded-2xl">
          <p className="text-sm font-medium text-foreground">备注视图</p>
          <p className="mt-1 text-sm text-muted-foreground">这里适合放说明、限制和后续约定。</p>
        </Surface>
      </TabsContent>
    </Tabs>
  );
}

export function TooltipSection() {
  return (
    <div className="flex flex-wrap gap-3">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="icon" aria-label="查看帮助">
            <Question size={18} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>快速查看字段解释</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" icon={Bell}>
            悬停提醒
          </Button>
        </TooltipTrigger>
        <TooltipContent>默认在右下角显示 Toast</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" icon={SidebarSimple}>
            侧边导航
          </Button>
        </TooltipTrigger>
        <TooltipContent>适合展示一级信息架构</TooltipContent>
      </Tooltip>
    </div>
  );
}

export function DropdownSection() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" icon={DotsThreeOutlineVertical}>
          打开 Menu
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>页面操作</DropdownMenuLabel>
        <DropdownMenuItem>
          <Plus size={16} />
          新建演示卡片
        </DropdownMenuItem>
        <DropdownMenuItem>
          <MagicWand size={16} />
          复制示例配置
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem>
          <Info size={16} />
          查看组件说明
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SidebarPreviewSection({ folderItems, settingsNavItems, threadItems }: SidebarPreviewSectionProps) {
  return (
    <div className={demoShellPreviewClassName}>
      <div className="max-h-[22rem] overflow-y-auto">
        <AppSidebar
          activeSettingsTab="demo"
          currentMode="app"
          folderItems={folderItems}
          isSidebarVisible
          onOpenSettings={() => undefined}
          onReorderFolders={() => undefined}
          onReturnToApp={() => undefined}
          onSelectSettingsTab={() => undefined}
          onToggleSidebar={() => undefined}
          settingsNavItems={settingsNavItems}
          showFloatingSidebarToggle={false}
          threadItems={threadItems}
          titlebarMode="frameless"
        />
      </div>
    </div>
  );
}

export function CardListItemSection({ title, description, className }: ShowcaseSectionProps) {
  return (
    <ShowcaseSection title={title} description={description} className={className}>
      <div className="space-y-3">
        <div className={cn("space-y-3", showcasePanelClassName)}>
          <div className={cn("flex items-start justify-between gap-4", showcaseTileClassName)}>
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">今日复习计划</p>
              <p className="text-sm text-muted-foreground">12 个待复习卡片，预计 18 分钟完成。</p>
            </div>
            <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">Ready</span>
          </div>

          <div className="space-y-2">
            <ListItemPreview title="语义拆分规则" meta="最后更新于 10 分钟前" active />
            <ListItemPreview title="Anki 模板映射" meta="3 个字段待校对" />
            <ListItemPreview title="统计看板指标" meta="已完成 8 / 10 项" />
          </div>
        </div>
      </div>
    </ShowcaseSection>
  );
}

export function FeedbackPatternsSection({ title, description, className, toastVisible, onShowToast }: FeedbackPatternsSectionProps) {
  return (
    <section className={cn(feedbackFrameClassName, className)}>
      <div className="border-b border-black/6 px-6 py-5 dark:border-white/8">
        <div className="space-y-2">
          <h3 className="text-lg font-semibold text-foreground">{title}</h3>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
        </div>
      </div>

      <div className="px-6 py-6">
        <div className="grid gap-3 lg:grid-cols-3">
          <div className={cn("flex flex-col items-start gap-3", feedbackPanelClassName)}>
            <div className="rounded-xl bg-primary/10 p-3 text-primary">
              <Cards size={20} />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">这里还没有卡片模板</p>
              <p className="text-sm text-muted-foreground">创建第一个模板后，学习卡片会从这里开始复用。</p>
            </div>
            <Button size="sm">去创建模板</Button>
          </div>

          <div className={cn("space-y-3", feedbackPanelClassName)}>
            <div className={cn("space-y-3", feedbackTileClassName)}>
              <p className="text-sm font-medium text-foreground">骨架屏预览</p>
              <SkeletonBlock className="h-4 w-24" />
              <SkeletonBlock className="h-12 w-full" />
              <SkeletonBlock className="h-12 w-full" />
              <SkeletonBlock className="h-12 w-3/4" />
            </div>
          </div>

          <div className={cn("flex flex-col items-start gap-3", feedbackPanelClassName)}>
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">触发一个 Toast</p>
              <p className="text-sm text-muted-foreground">用来确认轻量成功反馈是否符合当前主题，预览范围限定在当前区块内部。</p>
            </div>
            <Button variant="secondary" onClick={onShowToast}>
              显示 Toast
            </Button>
            {toastVisible ? (
              <output aria-live="polite" className={feedbackToastClassName}>
                <div className="flex items-start gap-3">
                  <div className="rounded-full bg-primary/10 p-2 text-primary">
                    <CheckCircle size={18} />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium text-foreground">Toast 已触发</p>
                    <p className="text-sm text-muted-foreground">这是一条用于预览反馈样式的演示通知。</p>
                  </div>
                </div>
              </output>
            ) : (
              <div className={cn("space-y-1", feedbackTileClassName)}>
                <p className="text-sm font-medium text-foreground">等待触发</p>
                <p className="text-sm text-muted-foreground">点击按钮后，在这里检查反馈层级、间距和图标权重。</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
