/**
 * UserMessageBubble - 用户消息气泡容器
 *
 * 功能：
 * 1. 圆角气泡样式（类似 Codex/iMessage）
 * 2. 长文本截断 + 渐隐 + "展开全文" 按钮（阈值 160px）
 * 3. 支持亮色/暗色主题
 */

import React, { useRef, useState, useEffect, useCallback } from 'react';
import { CaretDown, CaretUp } from '@phosphor-icons/react';
import { cn } from '@/utils/cn';
import { useTranslation } from 'react-i18next';

// ============================================================================
// 常量
// ============================================================================

/** 截断高度阈值（px） */
const COLLAPSE_HEIGHT_THRESHOLD = 160;

// ============================================================================
// Props
// ============================================================================

export interface UserMessageBubbleProps {
  children: React.ReactNode;
  className?: string;
}

// ============================================================================
// 组件
// ============================================================================

export const UserMessageBubble: React.FC<UserMessageBubbleProps> = ({
  children,
  className,
}) => {
  const { t } = useTranslation();
  const contentRef = useRef<HTMLDivElement>(null);
  const [isOverflow, setIsOverflow] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  // 检测内容是否超出阈值
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    const check = () => {
      setIsOverflow(el.scrollHeight > COLLAPSE_HEIGHT_THRESHOLD);
    };

    check();

    // 监听内容变化（图片加载等可能改变高度）
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [children]);

  const toggleExpand = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const shouldTruncate = isOverflow && !isExpanded;

  return (
    <div className={cn('user-message-bubble', className)}>
      {/* 内容区域 */}
      <div
        ref={contentRef}
        className={cn(
          'user-message-bubble__content',
          shouldTruncate && 'user-message-bubble__content--truncated'
        )}
        style={shouldTruncate ? { maxHeight: `${COLLAPSE_HEIGHT_THRESHOLD}px` } : undefined}
      >
        {children}
      </div>

      {/* 展开/收起按钮 */}
      {isOverflow && (
        <button
          type="button"
          className="user-message-bubble__toggle"
          onClick={toggleExpand}
          aria-expanded={isExpanded}
        >
          {isExpanded ? (
            <>
              <CaretUp size={14} />
              <span>{t('messageItem.bubble.collapse', '收起')}</span>
            </>
          ) : (
            <>
              <CaretDown size={14} />
              <span>{t('messageItem.bubble.expand', '展开全文')}</span>
            </>
          )}
        </button>
      )}
    </div>
  );
};

export type { UserMessageBubbleProps as Props };
