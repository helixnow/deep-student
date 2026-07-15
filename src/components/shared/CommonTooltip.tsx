import React, { useCallback, useState, useRef, useEffect, useId } from 'react';
import { createPortal } from 'react-dom';
import { Z_INDEX } from '@/config/zIndex';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { useOverlayCoordinator } from './OverlayCoordinator';
import './CommonTooltip.css';

export type TooltipPosition = 'top' | 'bottom' | 'left' | 'right';
export type TooltipTheme = 'dark' | 'light' | 'auto';
export const DEFAULT_TOOLTIP_DELAY_MS = 500;

export interface CommonTooltipProps {
  /** 提示内容 */
  content: React.ReactNode;
  /** 气泡位置 */
  position?: TooltipPosition;
  /** 主题：dark=深色气泡、light=浅色气泡、auto=跟随系统 */
  theme?: TooltipTheme;
  /** 是否禁用 */
  disabled?: boolean;
  /** 偏移距离（px） */
  offset?: number;
  /** 是否显示箭头 */
  showArrow?: boolean;
  /** 延迟显示时间（ms），0为立即显示 */
  delay?: number;
  /** 最大宽度 */
  maxWidth?: number | string;
  /** 自定义className */
  className?: string;
  /**
   * 快捷键角标：在提示文案右侧渲染 kbd 键位（如 "⌘K" 或 ["⌘", "K"]）。
   * 用于让键位提示渗透到各处 Tooltip（借鉴 OpenCode 界面处处标键位）。
   */
  shortcut?: string | string[];
  /** 子元素 */
  children: React.ReactElement;
}

/**
 * 通用悬浮提示气泡组件
 * 
 * @example
 * ```tsx
 * <CommonTooltip content="这是提示内容">
 *   <button>鼠标悬停</button>
 * </CommonTooltip>
 * 
 * <CommonTooltip content="右侧提示" position="right" theme="light">
 *   <span>查看提示</span>
 * </CommonTooltip>
 * ```
 */
export const CommonTooltip: React.FC<CommonTooltipProps> = ({
  content,
  position = 'top',
  theme = 'auto',
  disabled = false,
  offset = 8,
  showArrow = true,
  delay = DEFAULT_TOOLTIP_DELAY_MS,
  maxWidth = 300,
  className = '',
  shortcut,
  children,
}) => {
  const tooltipId = useId();
  const [isVisible, setIsVisible] = useState(false);
  const [tooltipPos, setTooltipPos] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  // 触屏支持：记录最近一次 pointer 类型，touch tap 时切换 tooltip（无自身点击行为的元素）
  const lastPointerTypeRef = useRef<string>('');
  const { dismissTooltips, tooltipDismissVersion, tooltipsSuppressed } = useOverlayCoordinator();
  const isTooltipDisabled = disabled || tooltipsSuppressed;
  // 子元素是否有自身点击行为（按钮类）。纯提示元素在触屏上 tap 即可查看提示
  const childHasOwnClick = typeof children.props.onClick === 'function';

  const clearShowTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // 计算tooltip位置
  const calculatePosition = useCallback(() => {
    if (!triggerRef.current || !tooltipRef.current) return;

    const triggerRect = triggerRef.current.getBoundingClientRect();
    const tooltipRect = tooltipRef.current.getBoundingClientRect();
    // Entry transforms do not alter layout dimensions, so use offset* for
    // collision math and avoid feeding transient animation scale into it.
    const tooltipWidth = tooltipRef.current.offsetWidth || tooltipRect.width;
    const tooltipHeight = tooltipRef.current.offsetHeight || tooltipRect.height;
    
    let top = 0;
    let left = 0;

    switch (position) {
      case 'top':
        top = triggerRect.top - tooltipHeight - offset;
        left = triggerRect.left + (triggerRect.width - tooltipWidth) / 2;
        break;
      case 'bottom':
        top = triggerRect.bottom + offset;
        left = triggerRect.left + (triggerRect.width - tooltipWidth) / 2;
        break;
      case 'left':
        top = triggerRect.top + (triggerRect.height - tooltipHeight) / 2;
        left = triggerRect.left - tooltipWidth - offset;
        break;
      case 'right':
        top = triggerRect.top + (triggerRect.height - tooltipHeight) / 2;
        left = triggerRect.right + offset;
        break;
    }

    // 边界检测：防止超出视口
    const padding = 8;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const maxLeft = Math.max(padding, viewportWidth - tooltipWidth - padding);
    const maxTop = Math.max(padding, viewportHeight - tooltipHeight - padding);
    left = Math.min(Math.max(left, padding), maxLeft);
    top = Math.min(Math.max(top, padding), maxTop);

    setTooltipPos({ top, left });
  }, [offset, position]);

  const dismissTooltip = useCallback(() => {
    clearShowTimer();
    setIsVisible(false);
  }, [clearShowTimer]);

  // 鼠标进入
  const handleMouseEnter = () => {
    if (isTooltipDisabled || !content) return;

    clearShowTimer();
    if (delay > 0) {
      timerRef.current = setTimeout(() => {
        if (isTooltipDisabled) return;
        setIsVisible(true);
        timerRef.current = null;
      }, delay);
    } else {
      setIsVisible(true);
    }
  };

  // 鼠标离开
  const handleMouseLeave = () => {
    dismissTooltip();
  };

  // 当tooltip可见时计算位置
  useEffect(() => {
    if (isVisible) {
      calculatePosition();
    }
  }, [calculatePosition, isVisible]);

  const handlePositionUpdate = useCallback(() => {
    if (isVisible) {
      calculatePosition();
    }
  }, [calculatePosition, isVisible]);

  const handleDismiss = useCallback((event: Event) => {
    if ((event as KeyboardEvent).key !== 'Escape') return;
    dismissTooltip();
  }, [dismissTooltip]);

  const handleTriggerActivation = useCallback(() => {
    dismissTooltips();
    dismissTooltip();
  }, [dismissTooltip, dismissTooltips]);

  useEventRegistry(isVisible ? [
    {
      target: 'window',
      type: 'resize',
      listener: handlePositionUpdate as EventListener,
    },
    {
      target: 'window',
      type: 'scroll',
      listener: handlePositionUpdate as EventListener,
      options: true,
    },
    {
      target: 'window',
      type: 'keydown',
      listener: handleDismiss as EventListener,
    },
  ] : [], [handleDismiss, handlePositionUpdate, isVisible]);

  // 清理定时器
  useEffect(() => {
    return () => {
      clearShowTimer();
    };
  }, [clearShowTimer]);

  useEffect(() => {
    dismissTooltip();
  }, [dismissTooltip, tooltipDismissVersion]);

  useEffect(() => {
    if (isTooltipDisabled) {
      dismissTooltip();
    }
  }, [dismissTooltip, isTooltipDisabled]);

  // 触屏 tap 外部区域关闭 tooltip
  useEventRegistry(isVisible ? [
    {
      target: 'window',
      type: 'pointerdown',
      listener: ((event: PointerEvent) => {
        const target = event.target as Node | null;
        if (!target) return;
        if (triggerRef.current?.contains(target)) return;
        if (tooltipRef.current?.contains(target)) return;
        dismissTooltip();
      }) as EventListener,
    },
  ] : [], [dismissTooltip, isVisible]);

  // 克隆子元素并添加事件处理 + aria-describedby 关联
  const trigger = React.cloneElement(children, {
    ref: triggerRef,
    'aria-describedby': isVisible ? tooltipId : undefined,
    onMouseEnter: (e: React.MouseEvent) => {
      // 触屏 tap 会合成 mouseenter，交由 click 的 toggle 逻辑处理
      if (lastPointerTypeRef.current !== 'touch') {
        handleMouseEnter();
      }
      children.props.onMouseEnter?.(e);
    },
    onMouseLeave: (e: React.MouseEvent) => {
      if (lastPointerTypeRef.current !== 'touch') {
        handleMouseLeave();
      }
      children.props.onMouseLeave?.(e);
    },
    onPointerDown: (e: React.PointerEvent) => {
      lastPointerTypeRef.current = e.pointerType;
      // 触屏点击纯提示元素时不立即关闭（交由 click 切换显示）
      if (!(e.pointerType === 'touch' && !childHasOwnClick)) {
        handleTriggerActivation();
      }
      children.props.onPointerDown?.(e);
    },
    onClick: (e: React.MouseEvent) => {
      if (lastPointerTypeRef.current === 'touch' && !childHasOwnClick) {
        // 触屏：tap 切换 tooltip（无延迟），让纯提示内容在触屏可达
        if (!isTooltipDisabled && content) {
          clearShowTimer();
          setIsVisible((prev) => !prev);
        }
      } else {
        handleTriggerActivation();
      }
      children.props.onClick?.(e);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar' || e.key === 'ArrowDown') {
        handleTriggerActivation();
      }
      children.props.onKeyDown?.(e);
    },
    // 键盘可访问性支持 (WCAG 2.1)
    onFocus: (e: React.FocusEvent) => {
      handleMouseEnter();
      children.props.onFocus?.(e);
    },
    onBlur: (e: React.FocusEvent) => {
      handleMouseLeave();
      children.props.onBlur?.(e);
    },
  } as any);

  // 渲染tooltip内容
  const tooltipContent = isVisible && content && (
    <div
      ref={tooltipRef}
      id={tooltipId}
      className={`common-tooltip common-tooltip--${position} common-tooltip--${theme} ${showArrow ? 'common-tooltip--with-arrow' : ''} ${className}`}
      style={{
        position: 'fixed',
        top: tooltipPos.top,
        left: tooltipPos.left,
        maxWidth: typeof maxWidth === 'number' ? `${maxWidth}px` : maxWidth,
        zIndex: Z_INDEX.tooltip,
      }}
      role="tooltip"
      aria-hidden={!isVisible}
    >
      <div className="common-tooltip__content">
        {shortcut ? (
          <span className="common-tooltip__row">
            <span>{content}</span>
            <span className="common-tooltip__shortcut" aria-hidden="true">
              {(Array.isArray(shortcut) ? shortcut : [shortcut]).map((key, index) => (
                <kbd key={index} className="common-tooltip__kbd">{key}</kbd>
              ))}
            </span>
          </span>
        ) : (
          content
        )}
      </div>
      {showArrow && <div className="common-tooltip__arrow" />}
    </div>
  );

  return (
    <>
      {trigger}
      {tooltipContent && createPortal(tooltipContent, document.body)}
    </>
  );
};

export default CommonTooltip;
