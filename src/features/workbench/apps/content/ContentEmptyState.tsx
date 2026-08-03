/**
 * ContentEmptyState — 资源窗口的精致空态/异常占位卡（O17）
 *
 * 用于适配层自有的空态（如 launch 时缺 instanceKey），替代裸文本：
 * 居中占位卡 = 图标圆盘 + 标题 + 说明，视觉与 WindowBody 的休眠占位卡
 * 同语言。样式见 ContentAppWindow.css（wb-content-empty* 前缀）。
 *
 * legacy 视图自身的错误/空态（UnifiedAppPanel 错误分支等）保持原样，
 * 本组件不覆盖它们。
 */
import React from 'react';
import { FileDashed } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import './ContentAppWindow.css';

export interface ContentEmptyStateProps {
  title: string;
  description?: string;
  /** 缺省 FileDashed（虚线文件 = 资源缺失隐喻） */
  icon?: React.ReactNode;
  className?: string;
}

export const ContentEmptyState: React.FC<ContentEmptyStateProps> = ({
  title,
  description,
  icon,
  className,
}) => (
  <div className={cn('wb-content-empty', className)} role="note">
    <div className="wb-content-empty__icon" aria-hidden="true">
      {icon ?? <FileDashed size={30} weight="duotone" />}
    </div>
    <div className="wb-content-empty__title">{title}</div>
    {description && <div className="wb-content-empty__desc">{description}</div>}
  </div>
);

export default ContentEmptyState;
