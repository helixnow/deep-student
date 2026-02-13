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
        'inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground',
        className
      )}
      {...props}
    />
  )
);
TabsList.displayName = 'TabsList';

interface TabsTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
  // 可选样式：default（带激活底色与阴影）、bare（仅文字，配合外部“滑块”使用）
  variant?: 'default' | 'bare';
}

const TabsTrigger = React.forwardRef<HTMLButtonElement, TabsTriggerProps>(({ className, value, variant = 'default', ...props }, ref) => {
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
        'inline-flex items-center justify-center whitespace-nowrap text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
        variant === 'default' && 'rounded-sm px-3 py-1.5 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm',
        variant === 'bare' && 'bg-transparent data-[state=active]:bg-transparent data-[state=active]:shadow-none',
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
      className={cn('mt-4 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2', className)}
      {...props}
    />
  );
});
TabsContent.displayName = 'TabsContent';

export { Tabs, TabsList, TabsTrigger, TabsContent };
