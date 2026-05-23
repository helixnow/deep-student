/**
 * ThinkingIndicator — LLM 首 token 到达前的"正在思考"状态
 */

import React from 'react';
import { TextShimmer } from './ui/TextShimmer';
import './ThinkingIndicator.css';

export const ThinkingIndicator: React.FC<{ className?: string }> = ({ className }) => {
  return (
    <div className={`thinking-indicator ${className ?? ''}`} role="status" aria-label="正在思考">
      <TextShimmer className="thinking-indicator-text">正在思考...</TextShimmer>
    </div>
  );
};
