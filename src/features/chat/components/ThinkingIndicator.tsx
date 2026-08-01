/**
 * ThinkingIndicator — LLM 首 token 到达前的"正在思考"状态
 *
 * 视觉统一（2026-07 二轮改造 · 分区 A）：使用 motion.css 的
 * .chat-wait-text 共享类，保持等待态轻量且不占用正文空间。
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import './ThinkingIndicator.css';

export const ThinkingIndicator: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useTranslation('chatV2');
  const label = t('messageList.waitingLabel');
  return (
    <div className={`thinking-indicator ${className ?? ''}`} role="status" aria-label={label}>
      <span className="chat-wait-text">{label}</span>
    </div>
  );
};
