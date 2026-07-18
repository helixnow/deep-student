/**
 * 制卡任务统计图表 — SVG 环形图 + 横向柱状图
 */
import React from 'react';

export const DonutChart: React.FC<{
  data: { label: string; value: number; color: string }[];
  size?: number;
  centerLabel?: string;
}> = ({ data, size = 110, centerLabel = '' }) => {
  const total = data.reduce((s, d) => s + d.value, 0);

  if (total === 0) {
    return (
      <svg width={size} height={size} viewBox="0 0 120 120">
        <circle
          cx="60" cy="60" r="48" fill="none" stroke="currentColor" strokeWidth="12"
          className="text-muted-foreground/10"
        />
        <text x="60" y="55" textAnchor="middle" dominantBaseline="central"
          className="fill-muted-foreground/40" fontSize="16">0</text>
        <text x="60" y="75" textAnchor="middle" dominantBaseline="central"
          className="fill-muted-foreground/30" fontSize="11">{centerLabel}</text>
      </svg>
    );
  }

  const radius = 48;
  const circumference = 2 * Math.PI * radius;
  let accumulated = 0;
  const segments = data.filter(d => d.value > 0).map(d => {
    const pct = d.value / total;
    const offset = accumulated;
    accumulated += pct;
    return { ...d, pct, offset };
  });

  return (
    <svg width={size} height={size} viewBox="0 0 120 120">
      {segments.map((seg, i) => (
        <circle
          key={i}
          cx="60" cy="60" r={radius}
          fill="none"
          stroke={seg.color}
          strokeWidth="12"
          strokeDasharray={`${seg.pct * circumference} ${circumference}`}
          strokeDashoffset={-seg.offset * circumference}
          strokeLinecap="butt"
          transform="rotate(-90 60 60)"
          className="transition-all duration-700"
        />
      ))}
      <text x="60" y="55" textAnchor="middle" dominantBaseline="central"
        className="fill-foreground font-semibold" fontSize="22">{total}</text>
      <text x="60" y="75" textAnchor="middle" dominantBaseline="central"
        className="fill-muted-foreground" fontSize="11">{centerLabel}</text>
    </svg>
  );
};

export const HBarChart: React.FC<{
  items: { label: string; value: number }[];
  maxItems?: number;
}> = ({ items, maxItems = 5 }) => {
  const sorted = [...items].sort((a, b) => b.value - a.value).slice(0, maxItems);
  const max = sorted.length > 0 ? sorted[0].value : 1;

  return (
    <div className="space-y-2.5">
      {sorted.map((item, i) => (
        <div key={i} className="group">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[13px] text-foreground/80 truncate max-w-[200px]">
              {item.label}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums ml-2 flex-shrink-0">
              {item.value}
            </span>
          </div>
          <div className="h-1.5 bg-muted/40 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-700 bg-foreground/20 group-hover:bg-foreground/30"
              style={{ width: `${Math.max((item.value / max) * 100, 2)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
};
