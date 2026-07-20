/**
 * ThinkingIndicator — LLM 首 token 到达前的"正在思考"状态
 *
 * 视觉统一（2026-07 二轮改造 · 分区 A）：改挂 motion.css 的
 * .chat-wait-text + .chat-wait-dots 共享类（收敛 TextShimmer 双视觉，
 * 自带 prefers-reduced-motion 降级）。
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import './ThinkingIndicator.css';

export const ThinkingIndicator: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useTranslation('chatV2');
  const ariaLabel = t('messageList.waiting');
  // 文案不带省略号：末尾的三点由 chat-wait-dots 呼吸动画承担
  const label = t('messageList.waitingLabel');
  return (
    <div className={`thinking-indicator ${className ?? ''}`} role="status" aria-label={ariaLabel}>
      <span className="chat-wait-text">
        {label}
        <span className="chat-wait-dots" aria-hidden="true"><i /><i /><i /></span>
      </span>
    </div>
  );
};
