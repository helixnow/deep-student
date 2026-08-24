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
import { DsButton } from '@/components/ui/DsButton';
import { CaretRight } from '@phosphor-icons/react';
import type { BreadcrumbItem } from '../stores/finderStore';

/**
 * 触屏面包屑命中区扩展：min-h 让按钮真正占出 44px（--touch-target-size，
 * 不随根字号缩放）高的点击热区——负 margin 方案会被本容器与顶栏标题槽的
 * overflow-hidden 裁掉，有效点击高度只剩 ≈24px；px-1.5 同时提供真实的
 * 横向热区。仅 pointer:coarse 生效，桌面排版不变。
 */
const CRUMB_TOUCH_HIT_CLASS =
  '[@media(pointer:coarse)]:!px-1.5 [@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]';

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
    // rootTitle 变化也会影响测量宽度，需要重新检测
  }, [checkOverflow, breadcrumbs, rootTitle]);

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

  // overflow-hidden 只为裁横向溢出；触屏下容器与按钮用 min-h 真实占位，纵向热区不会被裁
  return (
    <div ref={containerRef} className={cn("flex w-full flex-col justify-center overflow-hidden [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]", className)}>
      {/* 完整路径（用于测量，displayMode !== 'full' 时隐藏） */}
      <div
        ref={fullPathRef}
        className={cn(
          "flex items-center justify-center gap-1 text-base font-semibold whitespace-nowrap",
          displayMode !== 'full' && "invisible absolute"
        )}
        aria-hidden={displayMode !== 'full'}
      >
        {/* 根目录（触屏用 min-h 真实占位扩大命中区，桌面排版不变） */}
        <DsButton variant="ghost" size="sm" onClick={() => onNavigate?.(-1)} className={cn('!h-auto !p-0 hover:text-primary truncate max-w-[120px]', CRUMB_TOUCH_HIT_CLASS)}>
          {rootTitle}
        </DsButton>

        {/* 面包屑路径 */}
        {breadcrumbs.map((item, index) => (
          <React.Fragment key={item.id}>
            <CaretRight size={16} className="flex-shrink-0 text-muted-foreground" />
            {index === breadcrumbs.length - 1 ? (
              // 当前文件夹（不可点击）
              <span className="truncate max-w-[120px]">{item.name}</span>
            ) : (
              // 中间层级（可点击）
              <DsButton variant="ghost" size="sm" onClick={() => onNavigate?.(index)} className={cn('!h-auto !p-0 hover:text-primary truncate max-w-[120px]', CRUMB_TOUCH_HIT_CLASS)}>
                {item.name}
              </DsButton>
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
          <DsButton variant="ghost" size="sm" onClick={() => onNavigate?.(-1)} className={cn('!h-auto !p-0 hover:text-primary truncate max-w-[80px]', CRUMB_TOUCH_HIT_CLASS)}>
            {rootTitle}
          </DsButton>
          <CaretRight size={16} className="flex-shrink-0 text-muted-foreground" />
          {/* 折叠层级入口：点击回到上一级（被折叠的最近层级），对齐 FinderToolbar 的 … 按钮 */}
          <DsButton
            variant="ghost"
            size="sm"
            onClick={() => onNavigate?.(breadcrumbs.length - 2)}
            className={cn('!h-auto !p-0 text-muted-foreground hover:text-primary', CRUMB_TOUCH_HIT_CLASS)}
            title={breadcrumbs[breadcrumbs.length - 2]?.name}
            aria-label={breadcrumbs[breadcrumbs.length - 2]?.name || '…'}
          >
            …
          </DsButton>
          <CaretRight size={16} className="flex-shrink-0 text-muted-foreground" />
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
