/**
 * 节点内联装饰角标：
 * - 优先级徽标（1–6，颜色分级）
 * - 进度环（0–100）
 * - 超链接图标（点击经安全白名单打开）
 * - 完成态 checkbox（style.showCheckbox 开启时替代纯划线视觉）
 *
 * 全部为内联小尺寸元素，不引入模态；样式见 styles/node-edge-enhancements.css。
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Check, LinkSimple } from '@phosphor-icons/react';
import { openUrl } from '@/utils/urlOpener';

/** 优先级 → 语义色（1 最高）。1/2 用警示族，3 用主色，其余中性 */
function priorityColor(priority: number): string {
  if (priority <= 1) return 'hsl(var(--destructive))';
  if (priority === 2) return 'hsl(var(--warning, 38 92% 50%))';
  if (priority === 3) return 'hsl(var(--primary))';
  return 'var(--mm-text-muted)';
}

export const PriorityBadge: React.FC<{ priority: number }> = ({ priority }) => {
  const { t } = useTranslation('mindmap');
  const level = Math.max(1, Math.min(6, Math.round(priority)));
  return (
    <span
      className="mm-deco-priority select-none"
      style={{ backgroundColor: priorityColor(level) }}
      title={t('node.priorityBadge', { level, defaultValue: `优先级 ${level}` })}
      aria-label={t('node.priorityBadge', { level, defaultValue: `优先级 ${level}` })}
    >
      {level}
    </span>
  );
};

export const ProgressRing: React.FC<{ progress: number }> = ({ progress }) => {
  const { t } = useTranslation('mindmap');
  const percent = Math.max(0, Math.min(100, Math.round(progress)));
  const radius = 5;
  const circumference = 2 * Math.PI * radius;
  const dash = (percent / 100) * circumference;
  return (
    <span
      className="mm-deco-progress select-none"
      title={t('node.progressLabel', { percent, defaultValue: `进度 ${percent}%` })}
      aria-label={t('node.progressLabel', { percent, defaultValue: `进度 ${percent}%` })}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <circle
          cx="7"
          cy="7"
          r={radius}
          fill="none"
          stroke="var(--mm-border)"
          strokeWidth="2"
        />
        <circle
          cx="7"
          cy="7"
          r={radius}
          fill="none"
          stroke={percent >= 100 ? 'hsl(var(--success, 142 71% 45%))' : 'hsl(var(--primary))'}
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference - dash}`}
          transform="rotate(-90 7 7)"
        />
      </svg>
    </span>
  );
};

export const NodeLinkButton: React.FC<{ href: string }> = ({ href }) => {
  const { t } = useTranslation('mindmap');
  return (
    <button
      type="button"
      className="mm-deco-link nodrag nopan"
      title={href}
      aria-label={t('node.openLink', { defaultValue: '打开链接' })}
      onClick={(e) => {
        e.stopPropagation();
        void openUrl(href);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <LinkSimple weight="bold" aria-hidden="true" />
    </button>
  );
};

export const CompletedCheckbox: React.FC<{
  completed: boolean;
  disabled?: boolean;
  onToggle?: () => void;
}> = ({ completed, disabled = false, onToggle }) => {
  const { t } = useTranslation('mindmap');
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={completed}
      disabled={disabled}
      className={`mm-deco-checkbox nodrag nopan${completed ? ' is-checked' : ''}`}
      aria-label={t('node.toggleComplete', { defaultValue: '切换完成状态' })}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onToggle?.();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {completed && <Check weight="bold" aria-hidden="true" />}
    </button>
  );
};
