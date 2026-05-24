import React from 'react';
import { cn } from '@/lib/utils';
import type { ScanData } from './types';

type Props = { data: ScanData };

const statusColor = (pct: number) => {
  if (pct >= 90) return 'bg-[color:hsl(var(--success))]';
  if (pct >= 60) return 'bg-[color:hsl(var(--info))]';
  if (pct >= 30) return 'bg-[color:hsl(var(--warning))]';
  return 'bg-[color:hsl(var(--destructive))]';
};

const statusLabel = (pct: number) => {
  if (pct >= 90) return '已收口';
  if (pct >= 60) return '进行中';
  if (pct >= 30) return '需推进';
  return '待启动';
};

export function MigrationOverviewTab({ data }: Props) {
  const { migrationProgress, summary, cssMetrics, generatedAt, scanDurationMs } = data;

  const overallTarget = migrationProgress.reduce((s, p) => s + p.targetRefs, 0);
  const overallTotal = migrationProgress.reduce((s, p) => s + p.total, 0);
  const overallPct = overallTotal > 0 ? Math.round((overallTarget / overallTotal) * 100) : 0;

  return (
    <div className="space-y-6">
      {/* 总览卡片 */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard label="总体迁移率" value={`${overallPct}%`} detail={`${overallTarget} / ${overallTotal} refs`} />
        <MetricCard label="源码文件" value={String(summary.totalFiles)} detail={`${summary.tsxFiles} TSX · ${summary.cssFiles ?? 0} CSS`} />
        <MetricCard label="!important" value={String(cssMetrics.important?.count ?? 0)} detail={`${cssMetrics.important?.files ?? 0} 文件`} tone="warning" />
        <MetricCard label="硬编码颜色" value={String(cssMetrics.hardcodedColor?.count ?? 0)} detail={`${cssMetrics.hardcodedColor?.files ?? 0} 文件`} tone="warning" />
      </div>

      {/* 各组件族迁移进度 */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-[color:var(--text-secondary)]">组件族迁移进度</h3>
        <div className="space-y-2">
          {migrationProgress.map(entry => (
            <ProgressRow key={entry.id} entry={entry} components={data.components} />
          ))}
        </div>
      </div>

      {/* CSS 质量指标 */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-[color:var(--text-secondary)]">CSS 质量指标</h3>
        <div className="space-y-1.5">
          {Object.values(cssMetrics).map(metric => (
            <div key={metric.id} className="flex items-center justify-between rounded-md px-3 py-2 bg-[color:var(--surface-elevated)]">
              <span className="text-sm text-[color:var(--text-primary)]">{metric.label}</span>
              <div className="flex items-center gap-3">
                <span className="text-xs text-[color:var(--text-muted)]">{metric.files} 文件</span>
                <span className="text-sm font-mono font-medium text-[color:var(--text-primary)]">{metric.count.toLocaleString()}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 扫描元信息 */}
      <p className="text-xs text-[color:var(--text-muted)]">
        扫描于 {new Date(generatedAt).toLocaleString('zh-CN')} · 耗时 {scanDurationMs}ms · 运行 <code className="font-mono">node scripts/scan-component-usage.mjs</code> 刷新
      </p>
    </div>
  );
}

function MetricCard({ label, value, detail, tone }: { label: string; value: string; detail: string; tone?: 'warning' | 'danger' }) {
  return (
    <div className="rounded-lg border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] p-3">
      <p className="text-xs text-[color:var(--text-muted)]">{label}</p>
      <p className={cn('text-xl font-semibold font-mono mt-0.5', tone === 'warning' && 'text-[color:hsl(var(--warning))]', tone === 'danger' && 'text-[color:hsl(var(--destructive))]', !tone && 'text-[color:var(--text-primary)]')}>
        {value}
      </p>
      <p className="text-xs text-[color:var(--text-muted)] mt-0.5">{detail}</p>
    </div>
  );
}

function ProgressRow({ entry, components }: { entry: ScanData['migrationProgress'][number]; components: ScanData['components'] }) {
  const pct = entry.percentage;
  const targetNames = entry.targetIds.map(id => components[id]?.label ?? id).join(', ');
  const legacyNames = entry.legacyIds.map(id => components[id]?.label ?? id).join(', ');

  return (
    <div className="rounded-lg border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] px-4 py-3">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[color:var(--text-primary)]">{entry.label}</span>
          <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full font-medium', pct >= 90 && 'bg-[color:hsl(var(--success)/0.12)] text-[color:hsl(var(--success))]', pct >= 60 && pct < 90 && 'bg-[color:hsl(var(--info)/0.12)] text-[color:hsl(var(--info))]', pct >= 30 && pct < 60 && 'bg-[color:hsl(var(--warning)/0.12)] text-[color:hsl(var(--warning))]', pct < 30 && 'bg-[color:hsl(var(--destructive)/0.12)] text-[color:hsl(var(--destructive))]')}>
            {statusLabel(pct)}
          </span>
        </div>
        <span className="text-xs font-mono text-[color:var(--text-secondary)]">
          {entry.targetRefs} / {entry.total} ({pct}%)
        </span>
      </div>

      {/* 进度条 */}
      <div className="h-2 rounded-full bg-[color:var(--surface-muted)] overflow-hidden">
        <div className={cn('h-full rounded-full transition-all', statusColor(pct))} style={{ width: `${pct}%` }} />
      </div>

      {/* 详情 */}
      <div className="flex items-center gap-4 mt-1.5 text-[11px] text-[color:var(--text-muted)]">
        <span>目标: {targetNames}</span>
        {legacyNames && <span>遗留: {legacyNames}</span>}
      </div>
    </div>
  );
}
