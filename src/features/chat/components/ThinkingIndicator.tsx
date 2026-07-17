/**
 * ThinkingIndicator — LLM 首 token 到达前的"正在思考"状态
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { TextShimmer } from './ui/TextShimmer';
import './ThinkingIndicator.css';

export const ThinkingIndicator: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useTranslation('chatV2');
  const label = t('messageList.waiting');
  return (
    <div className={`thinking-indicator ${className ?? ''}`} role="status" aria-label={label}>
      <TextShimmer className="thinking-indicator-text">{label}</TextShimmer>
    </div>
  );
};
