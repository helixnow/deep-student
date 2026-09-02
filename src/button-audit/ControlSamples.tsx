import React, { useState } from 'react';
import { CaretDown, CaretRight, Check, Gear, MagnifyingGlass, Warning, X } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Input } from '@/components/ui/shad/Input';
import { Textarea } from '@/components/ui/shad/Textarea';
import { Switch } from '@/components/ui/shad/Switch';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/shad/Tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/shad/Select';
import { Slider } from '@/components/ui/shad/Slider';
import SnappySlider from '@/components/ui/SnappySlider';
import Progress from '@/components/ui/shad/Progress';
import { Badge } from '@/components/ui/shad/Badge';
import TagInput from '@/components/ui/shad/TagInput';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/shad/Alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/shad/Table';
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/shad/Breadcrumb';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/shad/Collapsible';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { Separator } from '@/components/ui/shad/Separator';
import { Label } from '@/components/ui/shad/Label';
import { PulseDot } from '@/components/ui/PulseDot';
import { Command, CommandInput, CommandItem, CommandList } from '@/components/ui/shad/Command';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SwitchRow } from '@/features/settings/components/settingsTabPrimitives';
import { ProgressRing } from '@/features/todo/components/main/detail/ProgressRing';
import ModernSelect from '@/components/ModernSelect';
import { PALETTE_PREVIEW_COLORS, PRESET_PALETTES } from '@/hooks/useTheme';
import { cn } from '@/lib/utils';
import type { ControlWidget } from './controlCatalog';
import '@/components/shared/CommonTooltip.css';
import '@/components/UnifiedNotification.css';
import '@/components/ui/app-menu/AppMenu.css';
import '@/components/ModernSelect.css';

function TooltipBubble({
  theme,
  shortcut,
  children,
}: {
  theme: 'dark' | 'light';
  shortcut?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'common-tooltip common-tooltip--visible common-tooltip--top common-tooltip--with-arrow',
        theme === 'dark' ? 'common-tooltip--dark' : 'common-tooltip--light',
      )}
      style={{ position: 'relative', opacity: 1, transform: 'none', pointerEvents: 'none' }}
    >
      <div className="common-tooltip__content">
        <div className="common-tooltip__viewport" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>{children}</span>
          {shortcut ? (
            <span className="common-tooltip__shortcut">
              <kbd className="common-tooltip__kbd">{shortcut}</kbd>
            </span>
          ) : null}
        </div>
      </div>
      <div className="common-tooltip__arrow" />
    </div>
  );
}

function ToastSample({
  type,
  text,
}: {
  type: 'success' | 'error' | 'info' | 'warning';
  text: string;
}) {
  const typeClass = {
    success: 'unified-notification-success',
    error: 'unified-notification-error',
    info: 'unified-notification-neutral',
    warning: 'unified-notification-warning',
  }[type];
  return (
    <div className={cn('unified-notification show', typeClass)} style={{ position: 'relative', pointerEvents: 'none' }}>
      <div className="unified-notification-content">
        <div className="unified-notification-text">{text}</div>
      </div>
    </div>
  );
}

function DialogMini({
  title,
  body,
  alert,
}: {
  title: string;
  body: string;
  alert?: boolean;
}) {
  return (
    <div
      className="ba-dialog-mini"
      style={{
        background: 'var(--dialog-shell-surface)',
        borderColor: 'var(--dialog-shell-border)',
        boxShadow: 'var(--shadow-shell-floating)',
      }}
    >
      {alert ? (
        <>
          <div className="flex items-start gap-3">
            <Warning size={18} className="mt-0.5 text-muted-foreground" />
            <div>
              <h3 className="text-sm font-semibold leading-tight">{title}</h3>
              <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{body}</p>
            </div>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <DsButton size="sm" variant="ghost">取消</DsButton>
            <DsButton size="sm" variant="danger">删除</DsButton>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-start justify-between gap-2 border-b px-0 pb-2" style={{ borderColor: 'var(--dialog-shell-border)' }}>
            <h3 className="text-sm font-semibold">{title}</h3>
            <X size={14} className="text-muted-foreground/50" />
          </div>
          <p className="mt-2 text-[12px] text-muted-foreground">{body}</p>
          <div className="mt-3 flex justify-end gap-2">
            <DsButton size="sm" variant="ghost">取消</DsButton>
            <DsButton size="sm" variant="ghost">确定</DsButton>
          </div>
        </>
      )}
    </div>
  );
}

export function ControlSample({ widget }: { widget: ControlWidget }) {
  const [tags, setTags] = useState(['机器学习', 'RAG']);
  const [on, setOn] = useState(true);
  const [seg, setSeg] = useState<'a' | 'b' | 'c'>('a');
  const [selectValue, setSelectValue] = useState('gpt');
  const [slider, setSlider] = useState([40]);
  const [snappy, setSnappy] = useState(0.7);
  const [step, setStep] = useState(6);
  const [modern, setModern] = useState('中文');
  const [collapse, setCollapse] = useState(true);

  switch (widget) {
    case 'input-text':
      return <Input placeholder="请输入名称" defaultValue="深度学习" />;
    case 'input-search':
      return <Input type="search" placeholder="搜索…" defaultValue="Transformer" />;
    case 'input-password':
      return <Input type="password" defaultValue="password123" />;
    case 'input-file':
      return <Input type="file" />;
    case 'input-disabled':
      return <Input disabled placeholder="不可编辑" defaultValue="只读" />;
    case 'input-native':
      return <input className="ba-native-input" placeholder="原生 input" defaultValue="未套壳" />;
    case 'textarea-shad':
      return <Textarea rows={3} defaultValue="这是 shad Textarea，和 Input 同一外壳。" />;
    case 'textarea-native':
      return <textarea className="ba-native-input" rows={3} defaultValue="原生 textarea" />;
    case 'textarea-composer':
      return (
        <div className="ba-composer">
          <textarea
            className="min-h-[44px] w-full resize-none border-none bg-transparent text-[15px] outline-none"
            rows={2}
            defaultValue="问一个关于注意力机制的问题…"
          />
        </div>
      );
    case 'switch-off':
      return <Switch />;
    case 'switch-on':
      return <Switch defaultChecked />;
    case 'switch-sm':
      return <Switch size="sm" defaultChecked />;
    case 'switch-disabled':
      return <Switch disabled defaultChecked />;
    case 'switch-row':
      return (
        <div className="w-full">
          <SwitchRow
            title="流式输出"
            description="生成时逐字显示"
            checked={on}
            onCheckedChange={setOn}
          />
        </div>
      );
    case 'checkbox-off':
      return (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox /> 未选
        </label>
      );
    case 'checkbox-on':
      return (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox defaultChecked /> 已选
        </label>
      );
    case 'checkbox-disabled':
      return (
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox disabled defaultChecked /> 禁用
        </label>
      );
    case 'segmented-default':
      return (
        <SegmentedControl
          ariaLabel="分段"
          value={seg}
          onValueChange={setSeg}
          options={[
            { value: 'a', label: '列表' },
            { value: 'b', label: '网格' },
            { value: 'c', label: '时间' },
          ]}
        />
      );
    case 'segmented-compact':
      return (
        <SegmentedControl
          ariaLabel="紧凑分段"
          size="compact"
          value={seg}
          onValueChange={setSeg}
          options={[
            { value: 'a', label: '日' },
            { value: 'b', label: '周' },
            { value: 'c', label: '月' },
          ]}
        />
      );
    case 'tabs-default':
      return (
        <Tabs defaultValue="one" className="w-full">
          <TabsList>
            <TabsTrigger value="one">常规</TabsTrigger>
            <TabsTrigger value="two">模型</TabsTrigger>
            <TabsTrigger value="three">数据</TabsTrigger>
          </TabsList>
        </Tabs>
      );
    case 'tabs-bare':
      return (
        <Tabs defaultValue="one" className="w-full">
          <TabsList className="border-0">
            <TabsTrigger variant="bare" value="one">大纲</TabsTrigger>
            <TabsTrigger variant="bare" value="two">画布</TabsTrigger>
          </TabsList>
        </Tabs>
      );
    case 'select-shad':
      return (
        <Select value={selectValue} onValueChange={setSelectValue}>
          <SelectTrigger>
            <SelectValue placeholder="选择模型" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="gpt">GPT</SelectItem>
            <SelectItem value="claude">Claude</SelectItem>
            <SelectItem value="local">本地</SelectItem>
          </SelectContent>
        </Select>
      );
    case 'select-native':
      return (
        <select className="ba-native-input" defaultValue="a">
          <option value="a">选项 A</option>
          <option value="b">选项 B</option>
        </select>
      );
    case 'select-combobox':
      return (
        <DsButton type="button" variant="ghost" className="w-full justify-between border border-border/30">
          <span className="truncate">Claude 4.5</span>
          <CaretDown size={16} className="opacity-70" />
        </DsButton>
      );
    case 'select-app':
      return (
        <button
          type="button"
          className="inline-flex h-9 items-center justify-between gap-2 rounded-[var(--radius-shell-control)] border border-input bg-background px-3 text-sm hover:bg-[var(--interactive-hover)]"
        >
          聊天
          <CaretDown size={12} className="opacity-70" />
        </button>
      );
    case 'select-modern':
      return <ModernSelect options={['中文', 'English']} value={modern} onChange={setModern} />;
    case 'slider-shad':
      return <Slider value={slider} onValueChange={setSlider} className="w-full" />;
    case 'slider-snappy':
      return (
        <SnappySlider
          className="w-full"
          values={[0, 0.3, 0.5, 0.7, 1]}
          defaultValue={0.7}
          value={snappy}
          onChange={setSnappy}
          min={0}
          max={1}
          step={0.1}
          label="温度"
        />
      );
    case 'slider-stepper':
      return (
        <div className="flex w-full items-center gap-2">
          <span className="w-16 shrink-0 truncate text-sm">选择</span>
          <Slider value={[step]} onValueChange={(v) => setStep(v[0] ?? 0)} max={20} className="min-w-0 flex-1" />
          <div className="flex shrink-0 items-center gap-0.5">
            <DsButton size="icon" iconOnly variant="ghost" onClick={() => setStep((n) => Math.max(0, n - 1))}>−</DsButton>
            <span className="w-7 text-center text-sm tabular-nums">{step}</span>
            <DsButton size="icon" iconOnly variant="ghost" onClick={() => setStep((n) => Math.min(20, n + 1))}>+</DsButton>
          </div>
        </div>
      );
    case 'progress-value':
      return <Progress value={62} className="w-full" />;
    case 'progress-indet':
      return <Progress value={null} className="w-full" />;
    case 'progress-ring':
      return <ProgressRing done={3} total={5} size={18} />;
    case 'badge-default':
      return <Badge variant="default">知识库</Badge>;
    case 'badge-secondary':
      return <Badge variant="secondary">次要</Badge>;
    case 'badge-destructive':
      return <Badge variant="destructive">失败</Badge>;
    case 'badge-outline':
      return <Badge variant="outline">描边</Badge>;
    case 'tag-input':
      return <TagInput value={tags} onChange={setTags} placeholder="添加标签" />;
    case 'tooltip-dark':
      return <TooltipBubble theme="dark">复制</TooltipBubble>;
    case 'tooltip-light':
      return <TooltipBubble theme="light">浅色提示</TooltipBubble>;
    case 'tooltip-kbd':
      return <TooltipBubble theme="dark" shortcut="⌘K">命令面板</TooltipBubble>;
    case 'tooltip-shad':
      return (
        <div className="rounded-md border border-border/40 bg-popover px-2 py-1 text-xs text-popover-foreground">
          遗留 Tooltip
        </div>
      );
    case 'toast-success':
      return <ToastSample type="success" text="已保存" />;
    case 'toast-error':
      return <ToastSample type="error" text="同步失败" />;
    case 'toast-info':
      return <ToastSample type="info" text="已复制到剪贴板" />;
    case 'toast-warning':
      return <ToastSample type="warning" text="磁盘空间不足" />;
    case 'alert-default':
      return (
        <Alert className="w-full">
          <AlertTitle>提示</AlertTitle>
          <AlertDescription>这是默认警告条。</AlertDescription>
        </Alert>
      );
    case 'alert-info':
      return (
        <Alert variant="info" className="w-full">
          <AlertTitle>信息</AlertTitle>
          <AlertDescription>需要重新登录后生效。</AlertDescription>
        </Alert>
      );
    case 'alert-warning':
      return (
        <Alert variant="warning" className="w-full">
          <AlertTitle>注意</AlertTitle>
          <AlertDescription>索引尚未完成。</AlertDescription>
        </Alert>
      );
    case 'alert-destructive':
      return (
        <Alert variant="destructive" className="w-full">
          <AlertTitle>错误</AlertTitle>
          <AlertDescription>无法连接同步服务。</AlertDescription>
        </Alert>
      );
    case 'dialog-ds':
      return <DialogMini title="重命名会话" body="输入新的名称，确定后写入本地库。" />;
    case 'dialog-alert':
      return <DialogMini alert title="删除此会话？" body="删除后无法恢复。" />;
    case 'dialog-shad':
      return <DialogMini title="遗留 Dialog" body="shad Dialog 几乎只剩对照页。" />;
    case 'sheet-right':
      return (
        <div className="ba-sheet-mini">
          <div className="flex items-center justify-between border-b border-border/40 px-3 py-2">
            <span className="text-sm font-medium">详情</span>
            <X size={14} className="text-muted-foreground" />
          </div>
          <p className="px-3 py-2 text-xs text-muted-foreground">从右侧滑入的 Sheet 面板。</p>
        </div>
      );
    case 'menu-app':
      return (
        <div className="app-menu-content ba-menu-open" style={{ position: 'relative', transform: 'none', opacity: 1, pointerEvents: 'auto' }}>
          <button type="button" className="app-menu-item">
            <span className="app-menu-item-icon"><Gear size={15} /></span>
            <span className="app-menu-item-content">设置</span>
          </button>
          <button type="button" className="app-menu-item app-menu-item-checked">
            <span className="app-menu-item-icon"><Check size={15} /></span>
            <span className="app-menu-item-content">已选中</span>
          </button>
          <div className="app-menu-separator" />
          <button type="button" className="app-menu-item">
            <span className="app-menu-item-content">删除</span>
          </button>
        </div>
      );
    case 'menu-popover':
      return (
        <div className="min-w-[180px] rounded-lg border border-border/40 bg-popover p-1.5 text-sm">
          <div className="rounded-md px-2 py-1.5 hover:bg-[var(--interactive-hover)]">打开</div>
          <div className="rounded-md px-2 py-1.5 hover:bg-[var(--interactive-hover)]">重命名</div>
        </div>
      );
    case 'card-shad':
      return (
        <Card className="w-full">
          <CardHeader className="p-3">
            <CardTitle className="text-sm">今日练习</CardTitle>
            <CardDescription>12 题待复习</CardDescription>
          </CardHeader>
          <CardContent className="p-3 pt-0 text-xs text-muted-foreground">卡片容器，无阴影。</CardContent>
        </Card>
      );
    case 'table-shad':
      return (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>状态</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>会话 A</TableCell>
              <TableCell>完成</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>会话 B</TableCell>
              <TableCell>进行中</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
    case 'breadcrumb':
      return (
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="#root">根目录</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator>
              <CaretRight size={12} />
            </BreadcrumbSeparator>
            <BreadcrumbItem>
              <BreadcrumbLink href="#notes">笔记</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator>
              <CaretRight size={12} />
            </BreadcrumbSeparator>
            <BreadcrumbItem>
              <BreadcrumbPage>机器学习.md</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      );
    case 'collapsible':
      return (
        <Collapsible open={collapse} onOpenChange={setCollapse} className="w-full">
          <CollapsibleTrigger className="flex w-full items-center justify-between text-sm">
            高级选项
            <CaretRight size={12} className={collapse ? 'rotate-90' : ''} />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <p className="mt-2 text-xs text-muted-foreground">展开后的内容。</p>
          </CollapsibleContent>
        </Collapsible>
      );
    case 'scroll-area':
      return (
        <ScrollArea className="h-20 w-full rounded-md border border-border/40">
          <div className="space-y-1 p-2 text-xs text-muted-foreground">
            {Array.from({ length: 12 }, (_, i) => (
              <div key={i}>可滚动行 {i + 1}</div>
            ))}
          </div>
        </ScrollArea>
      );
    case 'skeleton-shimmer':
      return <Skeleton className="h-8 w-full" />;
    case 'skeleton-pulse':
      return <Skeleton variant="pulse" className="h-8 w-full" />;
    case 'separator':
      return <Separator className="h-px w-full" />;
    case 'label':
      return <Label>显示名称</Label>;
    case 'pulse-dot':
      return <PulseDot className="h-2 w-2 text-primary" />;
    case 'command':
      return (
        <Command className="w-full rounded-md border border-border/40">
          <CommandInput placeholder="搜索命令…" />
          <CommandList>
            <CommandItem>新建会话</CommandItem>
            <CommandItem>打开设置</CommandItem>
          </CommandList>
        </Command>
      );
    case 'accent-dots':
      return (
        <div className="flex flex-wrap items-center gap-2">
          {PRESET_PALETTES.slice(0, 6).map((key, index) => (
            <span
              key={key}
              className={cn(
                'inline-flex h-7 w-7 rounded-full',
                index === 0 && 'ring-2 ring-foreground/50 ring-offset-2 ring-offset-background',
              )}
              style={{ background: PALETTE_PREVIEW_COLORS[key] }}
            />
          ))}
        </div>
      );
    case 'kbd-tooltip':
      return <kbd className="common-tooltip__kbd">⌘</kbd>;
    case 'kbd-inline':
      return <kbd className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px]">Esc</kbd>;
    default:
      return null;
  }
}
