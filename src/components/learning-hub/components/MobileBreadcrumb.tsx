/**
 * MobileBreadcrumb - 移动端响应式面包屑导航
 *
 * 特性：
 * - 宽度足够时显示完整路径：根目录 > 文件夹1 > 文件夹2
 * - 宽度不足但层级 ≤3 时显示压缩路径：根目录 > ... > 当前
 * - 宽度严重不足时只显示当前文件夹名称
 * - 点击面包屑项可导航到对应层级
 */

import React, { useRef, useState, useLayoutEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { ChevronRight } from 'lucide-react';
import type { BreadcrumbItem } from '../stores/finderStore';

export interface MobileBreadcrumbProps {
  /** 根目录标题 */
  rootTitle: string;
  /** 面包屑数据 */
  breadcrumbs: BreadcrumbItem[];
  /** 点击面包屑项的回调，index 为 -1 表示点击根目录 */
  onNavigate?: (index: number) => void;
  /** 额外的 className */
  className?: string;
}

/**
 * MobileBreadcrumb - 移动端响应式面包屑导航
 * 
 * 溢出策略（三级降级）：
 * 1. 完整路径：根目录 > A > B > C
 * 2. 压缩路径：根目录 > … > C（保留层级上下文）
 * 3. 仅当前名：C（极端窄屏）
 */
export const MobileBreadcrumb: React.FC<MobileBreadcrumbProps> = React.memo(({
  rootTitle,
  breadcrumbs,
  onNavigate,
  className,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const fullPathRef = useRef<HTMLDivElement>(null);
  const collapsedPathRef = useRef<HTMLDivElement>(null);
  // 'full' | 'collapsed' | 'minimal'
  const [displayMode, setDisplayMode] = useState<'full' | 'collapsed' | 'minimal'>('full');

  // 检测显示模式
  const checkOverflow = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const containerWidth = container.offsetWidth;

    // 先检测完整路径是否能放下
    if (fullPathRef.current) {
      if (fullPathRef.current.scrollWidth <= containerWidth) {
        setDisplayMode('full');
        return;
      }
    }

    // 再检测压缩路径（根目录 > … > 当前）是否能放下
    if (collapsedPathRef.current && breadcrumbs.length > 1) {
      if (collapsedPathRef.current.scrollWidth <= containerWidth) {
        setDisplayMode('collapsed');
        return;
      }
    }

    // 都放不下，仅显示当前名称
    setDisplayMode('minimal');
  }, [breadcrumbs]);

  // 监听容器大小变化
  useLayoutEffect(() => {
    checkOverflow();

    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      checkOverflow();
    });
    observer.observe(container);

    return () => observer.disconnect();
  }, [checkOverflow, breadcrumbs]);

  // 如果没有面包屑，只显示根目录标题
  if (breadcrumbs.length === 0) {
    return (
      <h1 className={cn("text-base font-semibold truncate", className)}>
        {rootTitle}
      </h1>
    );
  }

  // 当前文件夹名称（最后一个面包屑）
  const currentFolder = breadcrumbs[breadcrumbs.length - 1];

  return (
    <div ref={containerRef} className={cn("w-full overflow-hidden", className)}>
      {/* 完整路径（用于测量，displayMode !== 'full' 时隐藏） */}
      <div
        ref={fullPathRef}
        className={cn(
          "flex items-center justify-center gap-1 text-base font-semibold whitespace-nowrap",
          displayMode !== 'full' && "invisible absolute"
        )}
        aria-hidden={displayMode !== 'full'}
      >
        {/* 根目录 */}
        <NotionButton variant="ghost" size="sm" onClick={() => onNavigate?.(-1)} className="!h-auto !p-0 hover:text-primary truncate max-w-[120px]">
          {rootTitle}
        </NotionButton>

        {/* 面包屑路径 */}
        {breadcrumbs.map((item, index) => (
          <React.Fragment key={item.id}>
            <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
            {index === breadcrumbs.length - 1 ? (
              // 当前文件夹（不可点击）
              <span className="truncate max-w-[120px]">{item.name}</span>
            ) : (
              // 中间层级（可点击）
              <NotionButton variant="ghost" size="sm" onClick={() => onNavigate?.(index)} className="!h-auto !p-0 hover:text-primary truncate max-w-[120px]">
                {item.name}
              </NotionButton>
            )}
          </React.Fragment>
        ))}
      </div>

      {/* 压缩路径（用于测量）：根目录 > … > 当前文件夹 */}
      {breadcrumbs.length > 1 && (
        <div
          ref={collapsedPathRef}
          className={cn(
            "flex items-center justify-center gap-1 text-base font-semibold whitespace-nowrap",
            displayMode !== 'collapsed' && "invisible absolute"
          )}
          aria-hidden={displayMode !== 'collapsed'}
        >
          <NotionButton variant="ghost" size="sm" onClick={() => onNavigate?.(-1)} className="!h-auto !p-0 hover:text-primary truncate max-w-[80px]">
            {rootTitle}
          </NotionButton>
          <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground">…</span>
          <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          <span className="truncate max-w-[140px]">{currentFolder.name}</span>
        </div>
      )}

      {/* 极端模式：仅显示当前文件夹名称 */}
      {displayMode === 'minimal' && (
        <h1 className="text-base font-semibold truncate text-center">
          {currentFolder.name}
        </h1>
      )}
    </div>
  );
});

export default MobileBreadcrumb;
