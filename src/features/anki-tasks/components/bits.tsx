/**
 * 制卡任务 — 共享微组件（属性行 / 状态标签 / 内联进度条）
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SessionGroup } from '../types';

/** Notion 式 property 行（grid 响应式宽度） */
export const PropRow: React.FC<{
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}> = ({ icon, label, children }) => (
  <div className="grid grid-cols-[120px_1fr] sm:grid-cols-[150px_1fr] items-center py-[5px] group">
    <div className="flex items-center gap-2 min-w-0">
      <span className="text-muted-foreground/40 group-hover:text-muted-foreground/60 transition-colors flex-shrink-0">
        {icon}
      </span>
      <span className="text-[13px] text-muted-foreground truncate">
        {label}
      </span>
    </div>
    <div className="flex items-center gap-1 text-[13px] text-foreground min-w-0 flex-wrap">
      {children}
    </div>
  </div>
);

export const StatusTag: React.FC<{ group: SessionGroup }> = ({ group }) => {
  const { t } = useTranslation('anki');
  const config = {
    active: { text: t('taskDashboard.statusActive'), cls: 'text-[color:hsl(var(--info))] bg-[color:hsl(var(--info)/0.12)]' },
    attention: { text: t('taskDashboard.statusFailed'), cls: 'text-[color:hsl(var(--warning))] bg-[color:hsl(var(--warning)/0.14)]' },
    completed: { text: t('taskDashboard.statusDone'), cls: 'text-[color:hsl(var(--success))] bg-[color:hsl(var(--success)/0.14)]' },
  }[group];

  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded-sm ${config.cls}`}>
      {config.text}
    </span>
  );
};

export const InlineProgress: React.FC<{
  completed: number;
  total: number;
  failed: number;
}> = ({ completed, total, failed }) => {
  if (total === 0) return <span className="text-xs text-muted-foreground/50">—</span>;
  const pctDone = (completed / total) * 100;
  const pctFail = (failed / total) * 100;

  return (
    <div className="flex items-center gap-2.5">
      <div className="w-[80px] h-1.5 bg-muted/30 rounded-full overflow-hidden flex flex-shrink-0">
        <div className="h-full bg-[color:hsl(var(--success)/0.6)] transition-all duration-500" style={{ width: `${pctDone}%` }} />
        {pctFail > 0 && (
          <div className="h-full bg-[color:hsl(var(--warning)/0.6)] transition-all duration-500" style={{ width: `${pctFail}%` }} />
        )}
      </div>
      <span className="text-xs text-muted-foreground tabular-nums flex-shrink-0">
        {completed}/{total}
      </span>
    </div>
  );
};
