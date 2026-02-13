import React from 'react';
import { cn } from '../../utils/cn';
import { Card } from '../ui/shad/Card';
import { ChevronRight } from 'lucide-react';

interface ChatCollapsibleProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  countBadge?: React.ReactNode;
  headerRight?: React.ReactNode;
  forceMount?: boolean; // 强制挂载内容，便于流式渲染不中断
  contentId?: string;   // 可选：用于锚点跳转或无障碍关联
  containerClassName?: string; // 外层容器附加类（用于保留旧样式钩子）
}

// 轻量“shadcn风格”折叠容器，不引入新依赖，保持完全受控，不影响现有逻辑。
export const ChatCollapsible: React.FC<ChatCollapsibleProps> = ({
  open,
  onOpenChange,
  title,
  subtitle,
  countBadge,
  headerRight,
  children,
  forceMount = true,
  contentId,
  className,
  containerClassName,
  ...rest
}) => {
  const [bodyVisible, setBodyVisible] = React.useState(open || forceMount);

  React.useEffect(() => {
    if (open) {
      setBodyVisible(true);
      return;
    }
    if (!forceMount) {
      const timer = window.setTimeout(() => setBodyVisible(false), 200);
      return () => window.clearTimeout(timer);
    }
  }, [open, forceMount]);

  return (
    <Card
      className={cn(
        // 统一的shadcn风格外观（尽量克制），留白与边框一致
        'border-[1px] border-border/60 shadow-sm rounded-xl overflow-hidden bg-card',
        'transition-all',
        className,
        containerClassName,
      )}
      {...rest}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        className={cn(
          'flex items-center justify-between cursor-pointer select-none px-3 py-2.5',
          'bg-muted/90 border-b border-border/60'
        )}
        onClick={() => onOpenChange(!open)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpenChange(!open);
          }
        }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <ChevronRight
            className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-90')}
            aria-hidden
          />
          <div className="flex items-center gap-2 min-w-0">
            <div className="text-[13px] font-semibold text-foreground truncate">{title}</div>
            {subtitle && (
              <div className="text-[12px] text-muted-foreground truncate">{subtitle}</div>
            )}
            {countBadge}
          </div>
        </div>
        {headerRight && (
          <div className="ml-2 shrink-0 flex items-center gap-2">{headerRight}</div>
        )}
      </div>

      {(bodyVisible || forceMount) && (
        <div
          id={contentId}
          className={cn(
            'grid transition-all duration-250 ease-in-out motion-reduce:transition-none motion-reduce:duration-0',
            open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
          )}
          aria-hidden={!open}
        >
          <div className="overflow-hidden px-3 py-3">
            {children}
          </div>
        </div>
      )}
    </Card>
  );
};

export default ChatCollapsible;
