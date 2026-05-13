/**
 * 路径面包屑组件
 *
 * 数据契约来源：28-DSTU真实路径架构重构任务分配.md Prompt 8
 *
 * 功能：
 * 1. 显示当前位置的完整路径
 * 2. 支持点击任意层级快速跳转
 * 3. 路径过长时自动折叠中间层级
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Home, FolderOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import type { RealPathBreadcrumbItem } from '../hooks/useFolderNavigation';

// ============================================================================
// 类型定义
// ============================================================================

export interface PathBreadcrumbProps {
  /** 面包屑列表 */
  breadcrumbs: RealPathBreadcrumbItem[];
  /** 点击面包屑回调，index=-1 表示根目录 */
  onNavigate: (index: number) => void;
  /** 最大显示层级数（超过则折叠中间层级） */
  maxVisibleItems?: number;
  /** 自定义类名 */
  className?: string;
  /** 是否显示根目录图标 */
  showRootIcon?: boolean;
  /** 根目录显示文本 */
  rootLabel?: string;
}

// ============================================================================
// 组件实现
// ============================================================================

/**
 * 路径面包屑组件
 *
 * 显示当前文件夹路径，支持点击快速跳转
 * 使用 React.memo 优化，避免父组件重渲染时不必要的重渲染
 *
 * @example
 * ```tsx
 * <PathBreadcrumb
 *   breadcrumbs={[
 *     { folderId: 'fld_1', name: '高考复习', fullPath: '/高考复习' },
 *     { folderId: 'fld_2', name: '函数', fullPath: '/高考复习/函数' },
 *   ]}
 *   onNavigate={(index) => console.log('Navigate to:', index)}
 * />
 * ```
 */
export const PathBreadcrumb = React.memo(function PathBreadcrumb({
  breadcrumbs,
  onNavigate,
  maxVisibleItems = 4,
  className,
  showRootIcon = true,
  rootLabel,
}: PathBreadcrumbProps) {
  const { t } = useTranslation('learningHub');

  // 计算需要显示的面包屑项
  const visibleItems = useMemo(() => {
    if (breadcrumbs.length <= maxVisibleItems) {
      return {
        items: breadcrumbs,
        hasEllipsis: false,
        ellipsisItems: [] as RealPathBreadcrumbItem[],
      };
    }

    // 折叠中间层级，保留首尾
    const firstItems = breadcrumbs.slice(0, 1);
    const lastItems = breadcrumbs.slice(-(maxVisibleItems - 2));
    const ellipsisItems = breadcrumbs.slice(1, breadcrumbs.length - (maxVisibleItems - 2));

    return {
      items: [...firstItems, ...lastItems],
      hasEllipsis: true,
      ellipsisItems,
      ellipsisStartIndex: 1,
    };
  }, [breadcrumbs, maxVisibleItems]);

  // 根目录显示文本
  const rootText = rootLabel || t('folder.root', '根目录');

  return (
    <nav
      className={cn(
        'flex items-center gap-1 text-sm text-muted-foreground overflow-hidden',
        className
      )}
      aria-label={t('breadcrumb.ariaLabel', '路径导航')}
    >
      {/* 根目录 */}
      <NotionButton variant="ghost" size="sm" onClick={() => onNavigate(-1)} className={cn('!h-auto !px-1.5 !py-0.5', breadcrumbs.length === 0 && 'text-foreground font-medium')} title={rootText}>
        {showRootIcon && <Home className="h-3.5 w-3.5" />}
        {breadcrumbs.length === 0 && <span>{rootText}</span>}
      </NotionButton>

      {/* 面包屑项 */}
      {visibleItems.items.map((item, displayIndex) => {
        // 计算实际索引
        let actualIndex: number;
        if (visibleItems.hasEllipsis && displayIndex > 0) {
          // 折叠后的项，需要计算实际索引
          actualIndex = breadcrumbs.length - (visibleItems.items.length - displayIndex);
        } else {
          actualIndex = displayIndex;
        }

        const isLast = actualIndex === breadcrumbs.length - 1;

        return (
          <React.Fragment key={item.fullPath}>
            {/* 分隔符 */}
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50 flex-shrink-0" />

            {/* 折叠省略号（在第一个项后） */}
            {visibleItems.hasEllipsis && displayIndex === 1 && (
              <>
                <DropdownEllipsis
                  items={visibleItems.ellipsisItems}
                  onNavigate={(idx) => onNavigate(idx + 1)}
                />
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50 flex-shrink-0" />
              </>
            )}

            {/* 面包屑按钮 */}
            <NotionButton variant="ghost" size="sm" onClick={() => !isLast && onNavigate(actualIndex)} disabled={isLast} className={cn('!h-auto !px-1.5 !py-0.5 truncate max-w-[120px]', isLast ? 'text-foreground font-medium cursor-default' : '')} title={item.name}>
              {isLast && <FolderOpen className="h-3.5 w-3.5 flex-shrink-0" />}
              <span className="truncate">{item.name}</span>
            </NotionButton>
          </React.Fragment>
        );
      })}
    </nav>
  );
});

// ============================================================================
// 折叠省略号下拉组件
// 使用 React.memo 优化，避免面包屑重渲染时不必要的子组件重渲染
// ============================================================================

interface DropdownEllipsisProps {
  items: RealPathBreadcrumbItem[];
  onNavigate: (index: number) => void;
}

const DropdownEllipsis = React.memo(function DropdownEllipsis({ items, onNavigate }: DropdownEllipsisProps) {
  const { t } = useTranslation('learningHub');
  const [isOpen, setIsOpen] = React.useState(false);

  if (items.length === 0) {
    return null;
  }

  return (
    <div className="relative">
      <NotionButton variant="ghost" size="sm" onClick={() => setIsOpen(!isOpen)} onBlur={() => setTimeout(() => setIsOpen(false), 150)} className="!h-auto !px-1.5 !py-0.5" title={t('breadcrumb.hiddenFolders', '{{count}} 个隐藏文件夹', { count: items.length })}>
        <span className="text-muted-foreground">...</span>
      </NotionButton>

      {isOpen && (
        <div
          className={cn(
            'absolute top-full left-0 mt-1 z-50',
            'min-w-[140px] max-w-[200px] py-1',
            'bg-popover border border-border rounded-md shadow-md',
            'animate-in fade-in-0 zoom-in-95'
          )}
        >
          {items.map((item, index) => (
            <NotionButton key={item.fullPath} variant="ghost" size="sm" onClick={() => { onNavigate(index); setIsOpen(false); }} className="w-full !justify-start !px-3 !py-1.5 truncate" title={item.name}>
              {item.name}
            </NotionButton>
          ))}
        </div>
      )}
    </div>
  );
});

export default PathBreadcrumb;
