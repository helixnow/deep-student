import React from 'react';
import { CircleNotch, ArrowRight } from '@phosphor-icons/react';

export interface ActionCardProps {
  icon: React.ReactNode;
  label: string;
  count: number;
  hint: string;
  highlight: boolean;
  spinning?: boolean;
  onClick?: () => void;
}

/** 「今日指挥中心」行动卡片：一个计数 + 直达入口（`size: 'sm'` 小部件的标准外观）。 */
export const ActionCard: React.FC<ActionCardProps> = ({ icon, label, count, hint, highlight, spinning, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={[
      'group flex flex-1 min-w-[180px] items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors',
      highlight
        ? 'border-[color:hsl(var(--primary)/0.35)] bg-[color:hsl(var(--primary)/0.06)] hover:bg-[color:hsl(var(--primary)/0.1)]'
        : 'border-border bg-card hover:bg-muted/50',
    ].join(' ')}
  >
    <span
      className={[
        'flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md',
        highlight ? 'bg-[color:hsl(var(--primary)/0.12)] text-[color:hsl(var(--primary))]' : 'bg-muted text-muted-foreground',
      ].join(' ')}
    >
      {spinning ? <CircleNotch size={18} className="animate-spin" /> : icon}
    </span>
    <span className="flex-1 min-w-0">
      <span className="block text-[13px] text-muted-foreground">{label}</span>
      <span className="block text-[20px] font-semibold leading-tight tabular-nums text-foreground">
        {count}
      </span>
    </span>
    {/* 触屏无 hover：常显"前往"提示，保证入口可发现 */}
    <span className="flex items-center gap-0.5 text-[12px] text-muted-foreground/0 transition-colors group-hover:text-muted-foreground [@media(pointer:coarse)]:text-muted-foreground/70">
      {hint}
      <ArrowRight size={12} />
    </span>
  </button>
);
