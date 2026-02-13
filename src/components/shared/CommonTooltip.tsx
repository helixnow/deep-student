import React, { useState, useRef, useEffect, useId } from 'react';
import { createPortal } from 'react-dom';
import { Z_INDEX } from '@/config/zIndex';
import './CommonTooltip.css';

export type TooltipPosition = 'top' | 'bottom' | 'left' | 'right';
export type TooltipTheme = 'dark' | 'light' | 'auto';

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
  delay = 0,
  maxWidth = 300,
  className = '',
  children,
}) => {
  const tooltipId = useId();
  const [isVisible, setIsVisible] = useState(false);
  const [tooltipPos, setTooltipPos] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // 计算tooltip位置
  const calculatePosition = () => {
    if (!triggerRef.current || !tooltipRef.current) return;

    const triggerRect = triggerRef.current.getBoundingClientRect();
    const tooltipRect = tooltipRef.current.getBoundingClientRect();
    
    let top = 0;
    let left = 0;

    switch (position) {
      case 'top':
        top = triggerRect.top - tooltipRect.height - offset;
        left = triggerRect.left + (triggerRect.width - tooltipRect.width) / 2;
        break;
      case 'bottom':
        top = triggerRect.bottom + offset;
        left = triggerRect.left + (triggerRect.width - tooltipRect.width) / 2;
        break;
      case 'left':
        top = triggerRect.top + (triggerRect.height - tooltipRect.height) / 2;
        left = triggerRect.left - tooltipRect.width - offset;
        break;
      case 'right':
        top = triggerRect.top + (triggerRect.height - tooltipRect.height) / 2;
        left = triggerRect.right + offset;
        break;
    }

    // 边界检测：防止超出视口
    const padding = 8;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // 水平边界
    if (left < padding) {
      left = padding;
    } else if (left + tooltipRect.width > viewportWidth - padding) {
      left = viewportWidth - tooltipRect.width - padding;
    }

    // 垂直边界
    if (top < padding) {
      top = padding;
    } else if (top + tooltipRect.height > viewportHeight - padding) {
      top = viewportHeight - tooltipRect.height - padding;
    }

    setTooltipPos({ top, left });
  };

  // 鼠标进入
  const handleMouseEnter = () => {
    if (disabled || !content) return;

    if (delay > 0) {
      timerRef.current = setTimeout(() => {
        setIsVisible(true);
      }, delay);
    } else {
      setIsVisible(true);
    }
  };

  // 鼠标离开
  const handleMouseLeave = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setIsVisible(false);
  };

  // 当tooltip可见时计算位置
  useEffect(() => {
    if (isVisible) {
      calculatePosition();
      
      // 监听窗口大小变化和滚动
      const handleUpdate = () => calculatePosition();
      window.addEventListener('resize', handleUpdate);
      window.addEventListener('scroll', handleUpdate, true);
      
      return () => {
        window.removeEventListener('resize', handleUpdate);
        window.removeEventListener('scroll', handleUpdate, true);
      };
    }
  }, [isVisible]);

  // 清理定时器
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  // 克隆子元素并添加事件处理 + aria-describedby 关联
  const trigger = React.cloneElement(children, {
    ref: triggerRef,
    'aria-describedby': isVisible ? tooltipId : undefined,
    onMouseEnter: (e: React.MouseEvent) => {
      handleMouseEnter();
      children.props.onMouseEnter?.(e);
    },
    onMouseLeave: (e: React.MouseEvent) => {
      handleMouseLeave();
      children.props.onMouseLeave?.(e);
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
        {content}
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

