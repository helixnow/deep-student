import React, { useState, useContext } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { UnifiedSidebarContext } from './UnifiedSidebar';

export interface UnifiedSidebarSectionProps {
  /** 分组 ID */
  id: string;
  /** 标题 */
  title: string;
  /** 图标 */
  icon?: React.ComponentType<{ className?: string }>;
  /** 数量 */
  count?: number;
  /** 默认是否展开 */
  defaultOpen?: boolean;
  /** 受控展开状态 */
  open?: boolean;
  /** 展开状态变化回调 */
  onOpenChange?: (open: boolean) => void;
  /** 是否可折叠 */
  collapsible?: boolean;
  /** 右侧操作区域 */
  actions?: React.ReactNode;
  /** 子元素 */
  children: React.ReactNode;
  /** 自定义 className */
  className?: string;
  /** 两行布局：第一行显示图标和标题，第二行显示操作按钮 */
  twoLineLayout?: boolean;
  /** 快捷操作按钮（两行布局时显示在第一行右侧，替换展开箭头） */
  quickAction?: React.ReactNode;
  /** 是否显示分组容器样式（带背景和边框） */
  grouped?: boolean;
  /** 拖拽手柄属性，应用到头部使整个头部可拖拽 */
  dragHandleProps?: React.HTMLAttributes<HTMLDivElement> | null;
}

export const UnifiedSidebarSection: React.FC<UnifiedSidebarSectionProps> = ({
  title,
  icon: Icon,
  count,
  defaultOpen = true,
  open: controlledOpen,
  onOpenChange,
  collapsible = true,
  actions,
  children,
  className,
  twoLineLayout = false,
  quickAction,
  grouped = false,
  dragHandleProps,
}) => {
  // 使用可选上下文 - 允许在 UnifiedSidebar 外部独立使用
  const ctx = useContext(UnifiedSidebarContext);
  const displayMode = ctx?.displayMode ?? 'panel';
  const isMobileSlidingMode = ctx?.isMobileSlidingMode ?? false;
  const [internalOpen, setInternalOpen] = useState(defaultOpen);

  const isOpen = controlledOpen ?? internalOpen;
  const setIsOpen = (value: boolean) => {
    setInternalOpen(value);
    onOpenChange?.(value);
  };

  const isMobileMode = displayMode === 'sheet' || displayMode === 'drawer' || isMobileSlidingMode;

  const containerClasses = grouped
    ? 'rounded-md bg-muted/30 border border-border/40 py-1'
    : '';

  if (twoLineLayout) {
    return (
      <div className={cn('mb-1', containerClasses, className)}>
        <div
          {...(dragHandleProps ?? {})}
          className={cn(
            'flex items-center justify-between px-3 py-1.5 rounded-md transition-colors',
            collapsible && 'cursor-pointer hover:bg-accent/50'
          )}
          onClick={() => collapsible && setIsOpen(!isOpen)}
        >
          <div className="flex items-center gap-2">
            {Icon && <Icon className="w-4 h-4 text-muted-foreground" />}
            <span className={cn('font-semibold text-foreground/90', isMobileMode ? 'text-sm' : 'text-[13px]')}>
              {title}
            </span>
            {count !== undefined && (
              <span className="text-xs text-muted-foreground/50">({count})</span>
            )}
          </div>
          {quickAction && (
            <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
              {quickAction}
            </div>
          )}
        </div>
        {actions && (
          <div className="flex items-center gap-1 px-3 py-1" onClick={(e) => e.stopPropagation()}>
            {actions}
          </div>
        )}

        <AnimatePresence>
          {isOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="space-y-0.5">{children}</div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <div className={cn('mb-1', containerClasses, className)}>
      <div
        className={cn(
          'flex items-center justify-between px-3 py-1.5 rounded-md transition-colors',
          collapsible && 'cursor-pointer hover:bg-accent/50'
        )}
        onClick={() => collapsible && setIsOpen(!isOpen)}
      >
        <div className="flex items-center gap-2">
          {Icon && <Icon className="w-3 h-3 text-muted-foreground" />}
          <span
            className={cn(
              'font-semibold text-muted-foreground/60 uppercase tracking-wider',
              isMobileMode ? 'text-xs' : 'text-[11px]'
            )}
          >
            {title}
          </span>
          {count !== undefined && (
            <span className="text-xs text-muted-foreground/50">({count})</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {actions}
          {collapsible && (
            <ChevronRight
              className={cn(
                'w-3 h-3 text-muted-foreground/50 transition-transform duration-200',
                isOpen && 'rotate-90'
              )}
            />
          )}
        </div>
      </div>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="space-y-0.5">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
