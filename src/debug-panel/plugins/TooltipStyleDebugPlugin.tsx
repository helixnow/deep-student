import React, { useMemo, useState } from 'react';
import type { DebugPanelPluginProps } from '../DebugPanelHost';
import { CommonTooltip, type TooltipPosition, type TooltipTheme } from '@/components/shared/CommonTooltip';
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
import { NotionButton } from '@/components/ui/NotionButton';
import { Check, Copy, MousePointer2 } from 'lucide-react';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

const POSITIONS: TooltipPosition[] = ['top', 'right', 'bottom', 'left'];
const THEMES: TooltipTheme[] = ['dark', 'light', 'auto'];

function getTooltipText(position: TooltipPosition, theme: TooltipTheme, maxWidth: number) {
  return `用于样式调试的示例 Tooltip
位置: ${position}
主题: ${theme}
最大宽度: ${maxWidth}px

这段文字故意稍长一点，方便观察圆角、阴影、换行、内边距和边界处理。`;
}

function getShadTooltipClassName(theme: TooltipTheme) {
  if (theme === 'light') {
    return 'border border-border/60 bg-popover text-popover-foreground shadow-lg px-3 py-2 rounded-md text-xs leading-5 max-w-[var(--tooltip-max-width)]';
  }

  return 'border border-border/40 bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900 shadow-lg px-3 py-2 rounded-md text-xs leading-5 max-w-[var(--tooltip-max-width)]';
}

function PreviewCard({
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
    <section className="rounded-md border border-border/60 bg-background/70 p-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <p className="text-xs leading-5 text-muted-foreground">{description}</p>
          <code className="block text-[11px] leading-5 text-muted-foreground/80">{path}</code>
        </div>
      </div>
      <div className="rounded-md border border-dashed border-border/60 bg-muted/30 p-4">
        {children}
      </div>
      {note ? (
        <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-xs leading-5 text-amber-900 dark:text-amber-200">
          {note}
        </div>
      ) : null}
    </section>
  );
}

export default function TooltipStyleDebugPlugin({ isActive }: DebugPanelPluginProps) {
  const [position, setPosition] = useState<TooltipPosition>('top');
  const [theme, setTheme] = useState<TooltipTheme>('dark');
  const [showArrow, setShowArrow] = useState(true);
  const [delay, setDelay] = useState(0);
  const [maxWidth, setMaxWidth] = useState(260);
  const [copied, setCopied] = useState(false);

  const tooltipText = useMemo(
    () => getTooltipText(position, theme, maxWidth),
    [position, theme, maxWidth]
  );

  const titleText = useMemo(
    () => `原生 title\n位置由浏览器/系统接管\n建议只用来做基础兜底`,
    []
  );

  const copySummary = async () => {
    const payload = [
      'Tooltip style debug',
      `position=${position}`,
      `theme=${theme}`,
      `showArrow=${showArrow}`,
      `delay=${delay}`,
      `maxWidth=${maxWidth}`,
      'variants=CommonTooltip,shadcn Tooltip,promptkit Tooltip,native title',
    ].join('\n');

    await copyTextToClipboard(payload);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="space-y-3 border-b border-border/60 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">Tooltip 样式实验台</h2>
            <p className="text-xs leading-5 text-muted-foreground">
              这里把 CommonTooltip、shadcn Tooltip、promptkit Tooltip 和原生 <code>title</code> 放在同一块，方便横向比对。
            </p>
          </div>
          <NotionButton
            size="sm"
            variant="ghost"
            onClick={copySummary}
            aria-label="复制当前 tooltip 调试配置"
            title="复制当前 tooltip 调试配置"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            <span>{copied ? '已复制' : '复制配置'}</span>
          </NotionButton>
        </div>

        <div className="flex flex-wrap gap-2 text-xs">
          {POSITIONS.map((item) => (
            <NotionButton
              key={item}
              size="sm"
              variant={position === item ? 'primary' : 'ghost'}
              onClick={() => setPosition(item)}
              aria-label={`切换 tooltip 位置到 ${item}`}
            >
              {item}
            </NotionButton>
          ))}
          {THEMES.map((item) => (
            <NotionButton
              key={item}
              size="sm"
              variant={theme === item ? 'success' : 'ghost'}
              onClick={() => setTheme(item)}
              aria-label={`切换 tooltip 主题到 ${item}`}
            >
              {item}
            </NotionButton>
          ))}
          <NotionButton
            size="sm"
            variant={showArrow ? 'warning' : 'ghost'}
            onClick={() => setShowArrow((value) => !value)}
            aria-label="切换 tooltip 箭头显示"
          >
            Arrow {showArrow ? 'on' : 'off'}
          </NotionButton>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Delay</span>
            <input
              type="range"
              min={0}
              max={800}
              step={50}
              value={delay}
              onChange={(event) => setDelay(Number(event.target.value))}
              className="w-full"
            />
            <span className="text-xs text-muted-foreground">{delay} ms</span>
          </label>
          <label className="space-y-1">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Max Width</span>
            <input
              type="range"
              min={180}
              max={420}
              step={20}
              value={maxWidth}
              onChange={(event) => setMaxWidth(Number(event.target.value))}
              className="w-full"
            />
            <span className="text-xs text-muted-foreground">{maxWidth} px</span>
          </label>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
        <div className="grid gap-4 xl:grid-cols-2">
          <PreviewCard
            title="CommonTooltip"
            path="@/components/shared/CommonTooltip"
            description="项目里当前用得最多的一套。支持位置、主题、箭头、延迟、最大宽度。"
          >
            <div className="flex min-h-[120px] items-center justify-center">
              <CommonTooltip
                content={tooltipText}
                position={position}
                theme={theme}
                delay={delay}
                maxWidth={maxWidth}
                showArrow={showArrow}
                disabled={!isActive}
              >
                <NotionButton variant="primary" size="sm" aria-label="预览 CommonTooltip">
                  <MousePointer2 className="h-3.5 w-3.5" />
                  <span>Hover / Focus</span>
                </NotionButton>
              </CommonTooltip>
            </div>
          </PreviewCard>

          <PreviewCard
            title="shadcn Tooltip"
            path="@/components/ui/shad/Tooltip"
            description="debug 面板历史上还在用的 Radix 风格 API。这里只复用同一组位置和宽度参数。"
          >
            <div className="flex min-h-[120px] items-center justify-center" style={{ ['--tooltip-max-width' as string]: `${maxWidth}px` }}>
              <ShadTooltipProvider delayDuration={delay}>
                <ShadTooltip>
                  <ShadTooltipTrigger asChild>
                    <NotionButton variant="default" size="sm" aria-label="预览 shadcn Tooltip">
                      <MousePointer2 className="h-3.5 w-3.5" />
                      <span>Hover / Focus</span>
                    </NotionButton>
                  </ShadTooltipTrigger>
                  <ShadTooltipContent
                    side={position}
                    sideOffset={8}
                    className={getShadTooltipClassName(theme)}
                    style={{ maxWidth }}
                  >
                    {tooltipText}
                  </ShadTooltipContent>
                </ShadTooltip>
              </ShadTooltipProvider>
            </div>
          </PreviewCard>

          <PreviewCard
            title="promptkit Tooltip"
            path="@/promptkit/ui/tooltip"
            description="prompt-input 里在用的轻量包装。现在这个实现更像结构占位，便于你直接看 className 和内容样式。"
            note={
              <>
                <strong>当前实现是轻量占位。</strong> 它不会像另外两套一样自动悬浮出层，当前内容会原地渲染，所以这里更适合调文字、边框、背景和间距。
              </>
            }
          >
            <div className="flex min-h-[120px] flex-col items-center justify-center gap-3">
              <PromptkitTooltipProvider>
                <PromptkitTooltip>
                  <PromptkitTooltipTrigger className="inline-flex">
                    <NotionButton variant="secondary" size="sm" aria-label="预览 promptkit Tooltip">
                      <MousePointer2 className="h-3.5 w-3.5" />
                      <span>Trigger</span>
                    </NotionButton>
                  </PromptkitTooltipTrigger>
                  <PromptkitTooltipContent
                    className={`rounded-md border px-3 py-2 text-xs leading-5 shadow-sm ${
                      theme === 'light'
                        ? 'border-border/60 bg-popover text-popover-foreground'
                        : 'border-border/40 bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900'
                    }`}
                    style={{ maxWidth }}
                  >
                    {tooltipText}
                  </PromptkitTooltipContent>
                </PromptkitTooltip>
              </PromptkitTooltipProvider>
            </div>
          </PreviewCard>

          <PreviewCard
            title="原生 title"
            path="HTML title attribute"
            description="浏览器/系统自己画气泡，前端能控制的样式几乎没有。适合拿来当兜底，但不适合做统一视觉。"
            note="原生 title 需要真实 hover 才会出现，JSDOM 和大多数自定义调试容器都拿不到它的实际气泡 DOM。"
          >
            <div className="flex min-h-[120px] items-center justify-center">
              <NotionButton
                variant="ghost"
                size="sm"
                title={titleText}
                aria-label="预览原生 title"
              >
                <MousePointer2 className="h-3.5 w-3.5" />
                <span>Hover 原生 title</span>
              </NotionButton>
            </div>
          </PreviewCard>
        </div>
      </div>
    </div>
  );
}
