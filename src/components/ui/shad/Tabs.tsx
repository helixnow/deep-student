import * as React from 'react';
import { cn } from '../../../lib/utils';

type TabsContextValue = {
  value: string;
  setValue?: (v: string) => void;
};

const TabsContext = React.createContext<TabsContextValue>({ value: '' });

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

    return (
      <TabsContext.Provider value={{ value, setValue }}>
        <div ref={ref} className={cn('w-full', className)} {...props}>
          {children}
        </div>
      </TabsContext.Provider>
    );
  }
);
Tabs.displayName = 'Tabs';

const TabsList = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'inline-flex h-10 items-center justify-start gap-1 border-b border-[color:var(--shell-workspace-border)] bg-transparent text-[color:var(--text-secondary)] w-full',
        className
      )}
      {...props}
    />
  )
);
TabsList.displayName = 'TabsList';

const TabsTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { value: string; variant?: 'default' | 'bare' }
>(({ className, value, variant = 'default', ...props }, ref) => {
  const ctx = React.useContext(TabsContext);
  const active = ctx.value === value;
  return (
    <button
      ref={ref}
      type="button"
      onClick={(e) => {
        props.onClick?.(e);
        ctx.setValue?.(value);
      }}
      className={cn(
        'inline-flex min-h-8 items-center justify-center whitespace-nowrap rounded-[var(--radius-shell-control)] border border-transparent px-3 py-1.5 text-sm font-medium text-[color:var(--text-secondary)] ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--input-shell-focus)] disabled:pointer-events-none disabled:opacity-50 hover:bg-[color:var(--sidebar-quiet-hover)] hover:text-[color:var(--text-primary)] data-[state=active]:border-[color:var(--button-utility-border)] data-[state=active]:bg-[color:var(--surface-panel-strong)] data-[state=active]:text-[color:var(--text-primary)] data-[state=active]:shadow-[var(--shadow-shell-soft)]',
        variant === 'bare' && 'border-transparent bg-transparent data-[state=active]:border-transparent data-[state=active]:bg-transparent data-[state=active]:shadow-none',
        className
      )}
      data-state={active ? 'active' : 'inactive'}
      {...props}
    />
  );
});
TabsTrigger.displayName = 'TabsTrigger';

interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
}

const TabsContent = React.forwardRef<HTMLDivElement, TabsContentProps>(({ className, value, ...props }, ref) => {
  const ctx = React.useContext(TabsContext);
  const active = ctx.value === value;
  // 非激活状态直接不渲染，避免 hidden 属性被 flex 等 display 类覆盖
  if (!active) return null;
  return (
    <div
      ref={ref}
      role="tabpanel"
      className={cn('mt-4 ring-offset-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--input-shell-focus)]', className)}
      {...props}
    />
  );
});
TabsContent.displayName = 'TabsContent';

export { Tabs, TabsList, TabsTrigger, TabsContent };
