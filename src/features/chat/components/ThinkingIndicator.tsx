/**
 * ThinkingIndicator — LLM 首 token 到达前的"正在思考"状态
 *
 * 用跳动的圆点传达"AI 正在处理"，
 * 比骨架屏更符合用户对 AI 聊天的心智模型。
 */

import React from 'react';
import './ThinkingIndicator.css';

export const ThinkingIndicator: React.FC<{ className?: string }> = ({ className }) => {
  return (
    <div className={`thinking-indicator ${className ?? ''}`} role="status" aria-label="AI 正在思考">
      <div className="thinking-indicator-dots">
        <span className="thinking-indicator-dot" />
        <span className="thinking-indicator-dot" />
        <span className="thinking-indicator-dot" />
      </div>
      <span className="sr-only">正在思考</span>
    </div>
  );
};
