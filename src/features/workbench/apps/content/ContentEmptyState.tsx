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
}) => {
  // a11y：标题必须是真 heading 并作为区域的可访问名称暴露；
  // role="note" 对「资源缺失空态」语义不符，改用命名 region。
  const titleId = React.useId();
  return (
    <div className={cn('wb-content-empty', className)} role="region" aria-labelledby={titleId}>
      <div className="wb-content-empty__icon" aria-hidden="true">
        {icon ?? <FileDashed size={30} weight="duotone" />}
      </div>
      <h2 id={titleId} className="wb-content-empty__title">
        {title}
      </h2>
      {description && <div className="wb-content-empty__desc">{description}</div>}
    </div>
  );
};

export default ContentEmptyState;
