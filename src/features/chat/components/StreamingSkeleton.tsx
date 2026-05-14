/**
 * StreamingSkeleton — 流式响应等待骨架态
 *
 * 在首个 token 到达前显示 shimmer 骨架线，
 * 比单个 PulseDot 提供更丰富的视觉反馈。
 */

import React from 'react';
import './StreamingSkeleton.css';

export const StreamingSkeleton: React.FC<{ className?: string }> = ({ className }) => {
  return (
    <div className={`stream-skeleton ${className ?? ''}`} role="status" aria-label="Loading response">
      <div className="stream-skeleton-line" style={{ width: '82%' }} />
      <div className="stream-skeleton-line" style={{ width: '60%', animationDelay: '120ms' }} />
      <div className="stream-skeleton-line" style={{ width: '40%', animationDelay: '240ms' }} />
      <span className="sr-only">Loading</span>
    </div>
  );
};
