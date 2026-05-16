/**
 * ProfilerPanel
 *
 * 实时显示流式渲染 metrics 的面板：
 * - 4 个 metric card：TTFT / TPS / frame p95 / jank count
 * - 3 条 recharts 折线：backlog、TPS、frame ms
 * - Reset / Pause / Export Snapshot JSON
 *
 * 同时被 Playground 与 debug-panel 复用。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import {
  ArrowCounterClockwise,
  Pause,
  Play,
  DownloadSimple,
} from '@phosphor-icons/react';
import { cn } from '@/utils/cn';
import { streamingMarkdownProfiler } from '../../components/renderers/streamingProfiler';
import {
  subscribeMetrics,
  type StreamingMetricsBundle,
  type MetricsTimePoint,
} from '../../components/renderers/streamingMetrics';

export interface ProfilerPanelProps {
  className?: string;
  /** 嵌入到 debug-panel 等容器时使用，简化样式 */
  embedded?: boolean;
}

const EMPTY_BUNDLE: StreamingMetricsBundle = {
  metrics: {
    ttftMs: null,
    tps: 0,
    avgTps: 0,
    frameP50: 0,
    frameP95: 0,
    backlogCurrent: 0,
    backlogMax: 0,
    backlogMean: 0,
    jankCount: 0,
    totalChars: 0,
    totalDurationMs: 0,
    preset: null,
    eventCount: 0,
  },
  series: [],
  rawEvents: [],
};

const formatMs = (v: number | null): string => {
  if (v == null) return '—';
  if (v >= 1000) return `${(v / 1000).toFixed(2)}s`;
  return `${Math.round(v)}ms`;
};

const formatNum = (v: number): string => {
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return `${Math.round(v)}`;
};

interface MetricCardProps {
  label: string;
  value: string;
  hint?: string;
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
}

const MetricCard: React.FC<MetricCardProps> = ({ label, value, hint, tone = 'neutral' }) => {
  const toneClass =
    tone === 'good'
      ? 'text-emerald-600 dark:text-emerald-400'
      : tone === 'warn'
      ? 'text-amber-600 dark:text-amber-400'
      : tone === 'bad'
      ? 'text-red-600 dark:text-red-400'
      : 'text-foreground';
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-border bg-card/60 px-2.5 py-2">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">
        {label}
      </div>
      <div className={cn('text-base font-mono font-semibold tabular-nums', toneClass)}>
        {value}
      </div>
      {hint && (
        <div className="text-[10px] text-muted-foreground/80 font-mono">{hint}</div>
      )}
    </div>
  );
};

interface MiniChartProps {
  data: MetricsTimePoint[];
  dataKey: keyof MetricsTimePoint;
  color: string;
  label: string;
  unit?: string;
  height?: number;
}

const MiniChart: React.FC<MiniChartProps> = ({ data, dataKey, color, label, unit, height = 80 }) => {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between px-1">
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
          {label}
        </span>
        <span className="text-[10px] text-muted-foreground/70 font-mono">
          {data.length > 0 ? `${data[data.length - 1][dataKey]}${unit ?? ''}` : '—'}
        </span>
      </div>
      <div style={{ width: '100%', height }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
            <CartesianGrid stroke="hsl(var(--border))" strokeOpacity={0.3} vertical={false} />
            <XAxis
              dataKey="t"
              tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
              tickFormatter={(v) => `${(v / 1000).toFixed(1)}s`}
              stroke="hsl(var(--border))"
            />
            <YAxis
              tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
              width={32}
              stroke="hsl(var(--border))"
            />
            <Tooltip
              contentStyle={{
                background: 'hsl(var(--popover))',
                border: '1px solid hsl(var(--border))',
                borderRadius: 6,
                fontSize: 11,
                padding: '4px 8px',
              }}
              labelFormatter={(v) => `t=${v}ms`}
              formatter={(v: any) => [`${v}${unit ?? ''}`, label]}
            />
            <Line
              type="monotone"
              dataKey={dataKey}
              stroke={color}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

export const ProfilerPanel: React.FC<ProfilerPanelProps> = ({ className, embedded }) => {
  const [bundle, setBundle] = useState<StreamingMetricsBundle>(EMPTY_BUNDLE);
  const [enabled, setEnabled] = useState(() => streamingMarkdownProfiler.isEnabled());

  // 订阅 profiler 事件 → 派生 metrics
  useEffect(() => {
    streamingMarkdownProfiler.setEnabled(true);
    setEnabled(true);
    const unsub = subscribeMetrics((b) => setBundle(b));
    return () => {
      unsub();
    };
  }, []);

  const handleReset = useCallback(() => {
    streamingMarkdownProfiler.reset('profiler-panel');
  }, []);

  const handleTogglePause = useCallback(() => {
    const next = !streamingMarkdownProfiler.isEnabled();
    streamingMarkdownProfiler.setEnabled(next);
    setEnabled(next);
  }, []);

  const handleExport = useCallback(() => {
    const snapshot = {
      exportedAt: new Date().toISOString(),
      metrics: bundle.metrics,
      series: bundle.series,
      events: bundle.rawEvents,
    };
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `streaming-profiler-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [bundle]);

  const { metrics, series } = bundle;

  const ttftTone =
    metrics.ttftMs == null ? 'neutral' : metrics.ttftMs < 200 ? 'good' : metrics.ttftMs < 500 ? 'warn' : 'bad';
  const frameTone =
    metrics.frameP95 < 32 ? 'good' : metrics.frameP95 < 80 ? 'warn' : 'bad';
  const jankTone =
    metrics.jankCount === 0 ? 'good' : metrics.jankCount < 3 ? 'warn' : 'bad';

  // Tab：在嵌入模式下也可看 events
  const [tab, setTab] = useState<'overview' | 'events'>('overview');

  const recentEvents = useMemo(() => bundle.rawEvents.slice(-80).reverse(), [bundle.rawEvents]);

  return (
    <div className={cn('flex flex-col h-full overflow-hidden', !embedded && 'bg-card', className)}>
      {/* 工具栏 */}
      <div className="flex-shrink-0 px-3 py-2 border-b border-border flex items-center gap-1.5 flex-wrap">
        <button
          type="button"
          onClick={handleTogglePause}
          className={cn(
            'px-2 py-1 text-[11px] rounded flex items-center gap-1 transition-colors',
            enabled
              ? 'bg-muted hover:bg-amber-500/10 hover:text-amber-600'
              : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
          )}
          title={enabled ? '暂停采集' : '恢复采集'}
        >
          {enabled ? <Pause size={12} weight="fill" /> : <Play size={12} weight="fill" />}
          {enabled ? '暂停' : '恢复'}
        </button>
        <button
          type="button"
          onClick={handleReset}
          className="px-2 py-1 text-[11px] rounded bg-muted hover:bg-muted/80 transition-colors flex items-center gap-1"
          title="清空采集事件"
        >
          <ArrowCounterClockwise size={12} />
          清空
        </button>
        <button
          type="button"
          onClick={handleExport}
          disabled={metrics.eventCount === 0}
          className={cn(
            'px-2 py-1 text-[11px] rounded flex items-center gap-1 transition-colors',
            metrics.eventCount === 0
              ? 'bg-muted text-muted-foreground/50 cursor-not-allowed'
              : 'bg-muted hover:bg-primary/10 hover:text-primary',
          )}
          title="导出快照 JSON"
        >
          <DownloadSimple size={12} />
          导出
        </button>

        <div className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground font-mono">
          <span className="px-1.5 py-0.5 rounded bg-muted">{metrics.preset ?? '—'}</span>
          <span>{metrics.eventCount} 事件</span>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex-shrink-0 flex border-b border-border text-[11px]">
        {([
          { id: 'overview' as const, label: '概览' },
          { id: 'events' as const, label: '事件流' },
        ]).map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              'px-3 py-1.5 transition-colors',
              tab === id
                ? 'text-foreground border-b-2 border-primary -mb-px font-medium'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {tab === 'overview' ? (
          <>
            {/* Metric cards */}
            <div className="grid grid-cols-4 gap-1.5">
              <MetricCard
                label="首字耗时"
                value={formatMs(metrics.ttftMs)}
                hint="TTFT"
                tone={ttftTone}
              />
              <MetricCard
                label="瞬时 TPS"
                value={formatNum(metrics.tps)}
                hint={`平均 ${formatNum(metrics.avgTps)}`}
              />
              <MetricCard
                label="帧 p95"
                value={`${metrics.frameP95}ms`}
                hint={`p50 ${metrics.frameP50}ms`}
                tone={frameTone}
              />
              <MetricCard
                label="卡顿次数"
                value={`${metrics.jankCount}`}
                hint=">100ms 帧"
                tone={jankTone}
              />
            </div>

            <div className="grid grid-cols-2 gap-1.5">
              <MetricCard
                label="积压字符"
                value={`${metrics.backlogCurrent}`}
                hint={`峰值 ${metrics.backlogMax} · 均值 ${metrics.backlogMean}`}
              />
              <MetricCard
                label="总耗时"
                value={formatMs(metrics.totalDurationMs)}
                hint={`${metrics.totalChars} 字符`}
              />
            </div>

            {/* Charts */}
            {series.length > 1 ? (
              <div className="space-y-3 pt-2">
                <MiniChart
                  data={series}
                  dataKey="backlog"
                  color="hsl(var(--primary))"
                  label="积压（字符）"
                />
                <MiniChart
                  data={series}
                  dataKey="tps"
                  color="#10b981"
                  label="TPS（字符/秒）"
                />
                <MiniChart
                  data={series}
                  dataKey="frameMs"
                  color="#f59e0b"
                  label="帧间隔"
                  unit="ms"
                />
              </div>
            ) : (
              <div className="text-[11px] text-muted-foreground text-center py-8 border border-dashed border-border rounded-md">
                触发一次流式回复以采集指标
              </div>
            )}

            <div className="text-[10px] text-muted-foreground/70 font-mono pt-1">
              控制台:{' '}
              <code className="px-1 py-0.5 bg-muted rounded">
                window.__DEEP_STUDENT_STREAMING_PROFILER__.getSnapshot()
              </code>
            </div>
          </>
        ) : (
          <div className="font-mono text-[10px] space-y-0.5">
            {recentEvents.length === 0 ? (
              <div className="text-muted-foreground text-center py-8">
                暂无事件
              </div>
            ) : (
              recentEvents.map((ev) => {
                const eventColor =
                  ev.type === 'target'
                    ? 'text-amber-600 dark:text-amber-400'
                    : ev.type === 'display'
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : ev.type === 'flush'
                    ? 'text-sky-600 dark:text-sky-400'
                    : 'text-red-500';
                return (
                  <div
                    key={ev.id}
                    className="grid grid-cols-[40px_60px_50px_minmax(0,1fr)] gap-1.5 py-0.5 border-b border-border/30"
                  >
                    <span className={cn('font-medium', eventColor)}>{ev.type}</span>
                    <span className="text-muted-foreground">{ev.preset ?? '—'}</span>
                    <span className="text-muted-foreground">
                      {typeof ev.delta === 'number' ? `+${ev.delta}` : '—'}
                    </span>
                    <span className="text-muted-foreground/80 truncate">
                      目标={ev.targetLength ?? '—'} 已显={ev.displayedLength ?? '—'} 余={ev.remaining ?? '—'}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default ProfilerPanel;
