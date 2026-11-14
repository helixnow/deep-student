import * as React from 'react';
import { cn } from '../../../lib/utils';

type TabsPart = 'trigger' | 'panel';

type TabsContextValue = {
  value: string;
  setValue?: (v: string) => void;
  baseId?: string;
  triggers: readonly string[];
  panels: readonly string[];
  register?: (part: TabsPart, value: string) => () => void;
};

const TabsContext = React.createContext<TabsContextValue>({ value: '', triggers: [], panels: [] });

function partId(baseId: string | undefined, part: TabsPart, value: string): string | undefined {
  return baseId ? `${baseId}-${part}-${value.replace(/\s/g, '_')}` : undefined;
}

interface TabsProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
}

const Tabs = React.forwardRef<HTMLDivElement, TabsProps>(
  ({ className, value: controlled, defaultValue, onValueChange, children, ...props }, ref) => {
    const [internal, setInternal] = React.useState(defaultValue ?? '');
    const isControlled = controlled !== undefined;
    const value = isControlled ? (controlled as string) : internal;
    const setValue = React.useCallback(
      (v: string) => {
        if (!isControlled) setInternal(v);
        onValueChange?.(v);
      },
      [isControlled, onValueChange]
    );
    const baseId = React.useId();
    const [triggers, setTriggers] = React.useState<readonly string[]>([]);
    const [panels, setPanels] = React.useState<readonly string[]>([]);
    const register = React.useCallback((part: TabsPart, v: string) => {
      const update = part === 'trigger' ? setTriggers : setPanels;
      update((list) => [...list, v]);
      return () =>
        update((list) => {
          const index = list.indexOf(v);
          return index < 0 ? list : [...list.slice(0, index), ...list.slice(index + 1)];
        });
    }, []);
    const ctx = React.useMemo(
      () => ({ value, setValue, baseId, triggers, panels, register }),
      [value, setValue, baseId, triggers, panels, register]
    );

    return (
      <TabsContext.Provider value={ctx}>
        <div ref={ref} className={cn('w-full', className)} {...props}>
          {children}
        </div>
      </TabsContext.Provider>
    );
  }
);
Tabs.displayName = 'Tabs';

const TabsList = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, onKeyDown, ...props }, ref) => (
    <div
      ref={ref}
      role="tablist"
      className={cn(
        'inline-flex h-10 [@media(pointer:coarse)]:min-h-11 items-center justify-start gap-1 border-b border-[color:var(--shell-workspace-border)] bg-transparent text-[color:var(--text-secondary)] w-full',
        className
      )}
      {...props}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
        const list = event.currentTarget;
        const tabs = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]')).filter(
          (tab) => !tab.disabled && tab.closest('[role="tablist"]') === list
        );
        const index = tabs.indexOf(event.target as HTMLButtonElement);
        if (index < 0) return;
        const vertical = list.getAttribute('aria-orientation') === 'vertical';
        const last = tabs.length - 1;
        const next = {
          [vertical ? 'ArrowDown' : 'ArrowRight']: index === last ? 0 : index + 1,
          [vertical ? 'ArrowUp' : 'ArrowLeft']: index === 0 ? last : index - 1,
          Home: 0,
          End: last,
        }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        // 滚动只按最近边对齐（focus 默认会把标签滚到中间），可横向滚动的长标签栏不跳动
        tabs[next].focus({ preventScroll: true });
        tabs[next].scrollIntoView({ block: 'nearest', inline: 'nearest' });
        tabs[next].click();
      }}
    />
  )
);
TabsList.displayName = 'TabsList';

const TabsTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { value: string; variant?: 'default' | 'bare' }
>(({ className, value, variant = 'default', onClick, ...props }, ref) => {
  const ctx = React.useContext(TabsContext);
  const { register } = ctx;
  React.useLayoutEffect(() => register?.('trigger', value), [register, value]);
  const active = ctx.value === value;
  // 没有任何标签与当前值对应时，第一个标签保留 Tab 键可达
  const tabStop = active || (ctx.triggers[0] === value && !ctx.triggers.includes(ctx.value));
  // RUST-FIX(RF-W09-shared-tabs-aria-semantics): Rust 版标签是普通 button，没有 tablist/tab/aria-selected，调用方传 onClick 后标签不再切换
  return (
    <button
      ref={ref}
      type="button"
      role="tab"
      id={partId(ctx.baseId, 'trigger', value)}
      aria-selected={active}
      aria-controls={ctx.panels.includes(value) ? partId(ctx.baseId, 'panel', value) : undefined}
      tabIndex={tabStop ? 0 : -1}
      className={cn(
        // ui-state-colors：active/hover 切换时颜色/边框/阴影平滑过渡（transitions-dev token）
        'inline-flex min-h-8 [@media(pointer:coarse)]:min-h-11 items-center justify-center whitespace-nowrap rounded-[var(--radius-shell-control)] border border-transparent px-3 py-1.5 text-sm font-medium text-[color:var(--text-secondary)] ring-offset-background ui-state-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--input-shell-focus)] disabled:pointer-events-none disabled:opacity-50 hover:bg-[color:var(--sidebar-quiet-hover)] hover:text-[color:var(--text-primary)] data-[state=active]:border-[color:var(--button-utility-border)] data-[state=active]:bg-[color:var(--surface-panel-strong)] data-[state=active]:text-[color:var(--text-primary)] data-[state=active]:shadow-[var(--shadow-shell-soft)]',
        variant === 'bare' && 'border-transparent bg-transparent data-[state=active]:border-transparent data-[state=active]:bg-transparent data-[state=active]:shadow-none',
        className
      )}
      data-state={active ? 'active' : 'inactive'}
      {...props}
      onClick={(e) => {
        onClick?.(e);
        ctx.setValue?.(value);
      }}
    />
  );
});
TabsTrigger.displayName = 'TabsTrigger';

interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
}

const TabsContent = React.forwardRef<HTMLDivElement, TabsContentProps>(({ className, value, ...props }, ref) => {
  const ctx = React.useContext(TabsContext);
  const { register } = ctx;
  const active = ctx.value === value;
  React.useLayoutEffect(() => (active ? register?.('panel', value) : undefined), [active, register, value]);
  // 非激活状态直接不渲染，避免 hidden 属性被 flex 等 display 类覆盖
  if (!active) return null;
  return (
    <div
      ref={ref}
      role="tabpanel"
      id={partId(ctx.baseId, 'panel', value)}
      aria-labelledby={ctx.triggers.includes(value) ? partId(ctx.baseId, 'trigger', value) : undefined}
      // ui-rise-in：切换 tab 重挂载时播放 fade + 4px 上升入场（transitions-dev token）
      className={cn('mt-4 ui-rise-in ring-offset-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--input-shell-focus)]', className)}
      {...props}
    />
  );
});
TabsContent.displayName = 'TabsContent';

export { Tabs, TabsList, TabsTrigger, TabsContent };
