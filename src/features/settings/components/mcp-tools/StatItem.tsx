import { cn } from '@/lib/utils';

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
  const statusColors = {
    success: 'bg-success',
    warning: 'bg-warning',
    error: 'bg-destructive',
    neutral: 'bg-muted-foreground'
  };

  return (
    <div className="p-2 transition-colors">
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className="flex items-center gap-2">
        {status && (
          <span className={cn('w-2 h-2 rounded-full flex-shrink-0', statusColors[status])} />
        )}
        <span className="text-lg font-semibold text-foreground">{value}</span>
        {suffix && <span className="text-sm text-muted-foreground">{suffix}</span>}
      </div>
    </div>
  );
}
