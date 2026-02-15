/**
 * Chat V2 - 题目集引用徽章组件
 *
 * 在消息正文中渲染题目集引用的可点击徽章
 * 参照 MindmapCitationBadge 标准实现
 *
 * 支持：
 * - 点击跳转到 Learning Hub 打开对应题目集
 * - 显示题目集名称或 ID
 */

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { BookOpen } from 'lucide-react';

// ============================================================================
// 类型定义
// ============================================================================

export interface QbankCitationBadgeProps {
  /** 题目集 session ID */
  sessionId: string;
  /** 显示标题 */
  title?: string;
  /** 点击回调（覆盖默认跳转） */
  onClick?: () => void;
  /** 自定义类名 */
  className?: string;
}

// ============================================================================
// 组件实现
// ============================================================================

/**
 * QbankCitationBadge - 题目集引用徽章
 *
 * 内联可点击徽章，点击后跳转到 Learning Hub 打开对应题目集。
 * 使用 `navigateToExamSheet` 事件（与 ChatV2Page 中的统一跳转机制一致）。
 */
export const QbankCitationBadge: React.FC<QbankCitationBadgeProps> = ({
  sessionId,
  title,
  onClick,
  className,
}) => {
  const { t } = useTranslation('chatV2');

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (onClick) {
      onClick();
      return;
    }

    // 在右侧面板打开预览
    window.dispatchEvent(
      new CustomEvent('CHAT_OPEN_ATTACHMENT_PREVIEW', {
        detail: {
          id: sessionId,
          type: 'exam',
          title: title || '题目集',
        },
      })
    );
  }, [sessionId, title, onClick]);

  return (
    <NotionButton
      variant="ghost"
      size="sm"
      onClick={handleClick}
      className={cn(
        '!inline-flex !h-auto !px-1.5 !py-0.5 mx-0.5',
        'bg-emerald-500/10 hover:bg-emerald-500/20',
        'text-emerald-600 dark:text-emerald-400',
        'text-sm font-medium',
        'border border-emerald-500/20 hover:border-emerald-500/40',
        className
      )}
      title={t('qbankCitation.openTitle', {
        defaultValue: '打开题目集：{{title}}',
        title: title || sessionId,
      })}
    >
      <BookOpen className="w-3 h-3" />
      <span className="truncate max-w-[150px]">
        {title || t('qbankCitation.qbank', { defaultValue: '题目集' })}
      </span>
    </NotionButton>
  );
};

export default QbankCitationBadge;
