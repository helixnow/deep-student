// 1. React 核心
import React, { useCallback, useEffect, useRef, useState } from 'react';
// 2. 第三方库（按字母序）
import { useTranslation } from 'react-i18next';
// 3. @/ 路径别名
import { cn } from '@/utils/cn';
// 4. 相对路径
import {
  computeRemainingShineLockMs,
  EXPANDABLE_TOOL_MIN_SHINE_MS,
  isStaticNavigationTool,
  MAX_SHINE_LOCK_DURATION_MS,
  STATIC_TOOL_MIN_SHINE_MS,
} from './liveActivityEngine';

// ============================================================================
// Props 定义
// ============================================================================

export interface BlockLineCollapsibleProps {
  /** 是否处于展开状态（默认 true） */
  isExpanded?: boolean;
  /** 点击左侧 12px 竖线热区时触发收起回调 */
  onCollapse?: () => void;
  /** 兼容切换回调 */
  onToggle?: () => void;
  /** 顶部偏移（px） */
  topOffset?: number;
  /** 底部偏移（px） */
  bottomOffset?: number;
  /** 无障碍标签（可选，默认走 i18n） */
  collapseAriaLabel?: string;
  /** 外层容器自定义类名 */
  className?: string;
  /** 内容容器自定义类名 */
  contentClassName?: string;
  /** 展开块内容 */
  children: React.ReactNode;
}

export interface MinDurationShineBadgeProps {
  /** 工具当前是否处于运行态 */
  active: boolean;
  /** 是否为只读静态导航工具（true 默认锁 1000ms，false 默认锁 300ms） */
  isStaticTool?: boolean;
  /** 工具名称（未传 isStaticTool 时自动判定） */
  toolName?: string;
  /** 自定义最小扫光时长（毫秒） */
  minDurationMs?: number;
  /** 外部注入的起始毫秒时间戳（可选） */
  startedAtMs?: number;
  /** 自定义类名 */
  className?: string;
  /** 徽标内容 */
  children: React.ReactNode;
}

// ============================================================================
// 组件实现：BlockLineCollapsible（左侧 12px 竖线热区一键收起长输出）
// ============================================================================

export const BlockLineCollapsible: React.FC<BlockLineCollapsibleProps> = ({
  isExpanded = true,
  onCollapse,
  onToggle,
  topOffset = 0,
  bottomOffset = 0,
  collapseAriaLabel,
  className,
  contentClassName,
  children,
}) => {
  const { t } = useTranslation('chatV2');

  const handleTriggerCollapse = useCallback(
    (event: React.MouseEvent<HTMLSpanElement> | React.KeyboardEvent<HTMLSpanElement>) => {
      event.stopPropagation();
      if (onCollapse) {
        onCollapse();
        return;
      }
      if (onToggle) {
        onToggle();
        return;
      }
      const details = event.currentTarget.closest('details');
      if (details) {
        details.open = !details.open;
      }
    },
    [onCollapse, onToggle],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLSpanElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }
      event.preventDefault();
      handleTriggerCollapse(event);
    },
    [handleTriggerCollapse],
  );

  if (!isExpanded) {
    return null;
  }

  return (
    <div
      data-testid="block-line-collapsible"
      className={cn('relative ms-2 ps-3 pt-1 pb-2', className)}
    >
      <span
        role="button"
        tabIndex={0}
        data-testid="block-line-hit-area"
        aria-label={collapseAriaLabel ?? t('timeline.blockLine.collapse')}
        onClick={handleTriggerCollapse}
        onKeyDown={handleKeyDown}
        style={{ top: topOffset, bottom: bottomOffset }}
        className={cn(
          'group/blockline absolute -left-1.5 flex w-3 cursor-pointer items-stretch justify-center bg-transparent outline-none',
        )}
      >
        <span
          aria-hidden="true"
          data-testid="block-line-rail"
          className={cn(
            ' h-full w-px border-l border-border/35 bg-border/35 transition-colors duration-150',
            'group-hover/blockline:border-primary/50 group-hover/blockline:bg-primary/50',
            'group-focus-visible/blockline:border-primary/50 group-focus-visible/blockline:bg-primary/50',
          )}
        />
      </span>
      <div className={cn('min-w-0', contentClassName)}>
        {children}
      </div>
    </div>
  );
};

// ============================================================================
// 组件实现：MinDurationShineBadge（1000ms / 300ms 最小扫光锁）
// ============================================================================

export const MinDurationShineBadge: React.FC<MinDurationShineBadgeProps> = ({
  active,
  isStaticTool,
  toolName,
  minDurationMs,
  startedAtMs,
  className,
  children,
}) => {
  const effectiveIsStatic = isStaticTool ?? (toolName ? isStaticNavigationTool(toolName) : true);
  const resolvedMinDurationMs =
    typeof minDurationMs === 'number' && Number.isFinite(minDurationMs)
      ? Math.max(0, Math.trunc(minDurationMs))
      : effectiveIsStatic
        ? STATIC_TOOL_MIN_SHINE_MS
        : EXPANDABLE_TOOL_MIN_SHINE_MS;

  const busyStartRef = useRef<number | null>(
    active ? (startedAtMs ?? Date.now()) : null,
  );
  const [isShining, setIsShining] = useState<boolean>(active);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (active && busyStartRef.current === null) {
    busyStartRef.current = startedAtMs ?? Date.now();
  }

  useEffect(() => {
    if (typeof startedAtMs === 'number' && Number.isFinite(startedAtMs)) {
      busyStartRef.current = startedAtMs;
    }
  }, [startedAtMs]);

  useEffect(() => {
    if (active) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (busyStartRef.current === null) {
        busyStartRef.current = startedAtMs ?? Date.now();
      }

      const elapsed = Date.now() - busyStartRef.current;
      if (elapsed >= MAX_SHINE_LOCK_DURATION_MS) {
        setIsShining(false);
        busyStartRef.current = null;
        return undefined;
      }

      setIsShining(true);
      return undefined;
    }

    if (!isShining) {
      busyStartRef.current = null;
      return undefined;
    }

    const effectiveStartedAt = startedAtMs ?? busyStartRef.current ?? Date.now();
    const remainingMs = computeRemainingShineLockMs(
      effectiveStartedAt,
      Date.now(),
      effectiveIsStatic,
      resolvedMinDurationMs,
    );

    if (remainingMs <= 0) {
      setIsShining(false);
      busyStartRef.current = null;
      return undefined;
    }

    timerRef.current = setTimeout(() => {
      setIsShining(false);
      busyStartRef.current = null;
      timerRef.current = null;
    }, remainingMs);

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [active, effectiveIsStatic, isShining, resolvedMinDurationMs, startedAtMs]);

  return (
    <span
      data-testid="min-duration-shine-badge"
      data-shining={isShining ? 'true' : 'false'}
      data-min-duration-ms={resolvedMinDurationMs}
      className={cn(
        'inline-flex items-center transition-opacity duration-200',
        isShining && 'animate-pulse opacity-75',
        className,
      )}
    >
      {children}
    </span>
  );
};

export default BlockLineCollapsible;
