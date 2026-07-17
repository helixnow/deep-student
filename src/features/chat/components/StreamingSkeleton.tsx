/**
 * StreamingSkeleton — 流式响应等待骨架态
 *
 * 在首个 token 到达前显示 shimmer 骨架线，
 * 比单个 PulseDot 提供更丰富的视觉反馈。
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import './StreamingSkeleton.css';

export const StreamingSkeleton: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useTranslation('chatV2');
  const label = t('messageList.waiting');
  return (
    <div className={`stream-skeleton ${className ?? ''}`} role="status" aria-label={label}>
      <div className="stream-skeleton-line" style={{ width: '82%' }} />
      <div className="stream-skeleton-line" style={{ width: '60%', animationDelay: '120ms' }} />
      <div className="stream-skeleton-line" style={{ width: '40%', animationDelay: '240ms' }} />
      <span className="sr-only">{label}</span>
    </div>
  );
};
