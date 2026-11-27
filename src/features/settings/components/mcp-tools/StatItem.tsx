import { cn } from '@/utils/cn';

// 统计卡片组件
export function StatItem({
  label,
  value,
  suffix,
  status
}: {
  label: string;
  value: string | number;
  suffix?: string;
  status?: 'success' | 'warning' | 'error' | 'neutral';
}) {
  const statusTextColors = {
    success: 'text-success',
    warning: 'text-warning',
    error: 'text-destructive',
    neutral: 'text-foreground',
  };

  return (
    <div className="p-2 transition-colors">
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className="flex items-baseline gap-1.5">
        <span className={cn('text-lg font-semibold tabular-nums', status ? statusTextColors[status] : 'text-foreground')}>
          {value}
        </span>
        {suffix && <span className="text-sm text-muted-foreground">{suffix}</span>}
      </div>
    </div>
  );
}
