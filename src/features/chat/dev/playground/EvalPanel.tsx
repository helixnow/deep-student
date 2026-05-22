/**
 * EvalPanel
 *
 * 流式渲染评测面板：选择 cases × presets × rhythm，跑 benchmark，看分数热图。
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  Play,
  Stop,
  DownloadSimple,
  CheckSquare,
  Square as SquareIcon,
} from '@phosphor-icons/react';
import { cn } from '@/utils/cn';
import { EVAL_CASES } from './eval/cases';
import { RHYTHM_PRESETS, DEFAULT_RHYTHM } from './eval/rhythm';
import { runEval, type RunEvalProgress } from './eval/runner';
import { scoreToColor } from './eval/scoring';
import { getStreamingPresetHint, getStreamingPresetLabel } from './labels';
import type {
  EvalCaseResult,
  EvalReport,
  RhythmStrategy,
} from './eval/types';
import type { StreamingSmoothingPreset } from '@/features/chat/components/renderers/streamingSmoothing';

const ALL_PRESETS: StreamingSmoothingPreset[] = ['natural', 'realtime', 'balanced', 'silky', 'fluid'];

export interface EvalPanelProps {
  className?: string;
}

export const EvalPanel: React.FC<EvalPanelProps> = ({ className }) => {
  // 选择
  const [selectedCases, setSelectedCases] = useState<Set<string>>(
    () => new Set(EVAL_CASES.slice(0, 4).map((c) => c.id)),
  );
  const [selectedPresets, setSelectedPresets] = useState<Set<StreamingSmoothingPreset>>(
    () => new Set<StreamingSmoothingPreset>(['balanced', 'silky', 'realtime']),
  );
  const [rhythmId, setRhythmId] = useState<string>('fixed-fast');

  // 运行状态
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<RunEvalProgress | null>(null);
  const [report, setReport] = useState<EvalReport | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 详情展开
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const rhythm: RhythmStrategy = useMemo(
    () => RHYTHM_PRESETS.find((r) => r.id === rhythmId)?.rhythm ?? DEFAULT_RHYTHM,
    [rhythmId],
  );

  const toggleCase = (id: string) => {
    setSelectedCases((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const togglePreset = (p: StreamingSmoothingPreset) => {
    setSelectedPresets((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  const handleRun = useCallback(async () => {
    if (running) return;
    if (selectedCases.size === 0 || selectedPresets.size === 0) return;

    const cases = EVAL_CASES.filter((c) => selectedCases.has(c.id));
    const presets = ALL_PRESETS.filter((p) => selectedPresets.has(p));

    const abort = new AbortController();
    abortRef.current = abort;
    setRunning(true);
    setProgress(null);
    setReport(null);

    try {
      const result = await runEval({
        cases,
        presets,
        rhythm,
        caseTimeoutMs: 20000,
        signal: abort.signal,
        onProgress: (p) => setProgress(p),
      });
      setReport(result);
    } finally {
      setRunning(false);
      setProgress(null);
      abortRef.current = null;
    }
  }, [running, selectedCases, selectedPresets, rhythm]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleExport = useCallback(() => {
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `streaming-eval-report-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [report]);

  // 矩阵：cases × presets
  const matrix = useMemo(() => {
    if (!report) return null;
    const byKey = new Map<string, EvalCaseResult>();
    for (const r of report.results) byKey.set(`${r.caseId}::${r.preset}`, r);
    return byKey;
  }, [report]);

  const usedCases = useMemo(() => {
    if (!report) return [] as string[];
    return Array.from(new Set(report.results.map((r) => r.caseId)));
  }, [report]);
  const usedPresets = useMemo(() => {
    if (!report) return [] as StreamingSmoothingPreset[];
    return Array.from(new Set(report.results.map((r) => r.preset)));
  }, [report]);

  return (
    <div className={cn('flex flex-col h-full overflow-hidden', className)}>
      {/* 顶部控制 */}
      <div className="flex-shrink-0 px-3 py-2 border-b border-border space-y-2">
        {/* Cases 多选 */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] text-muted-foreground tracking-wider font-medium">
              测试用例 ({selectedCases.size}/{EVAL_CASES.length})
            </span>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => setSelectedCases(new Set(EVAL_CASES.map((c) => c.id)))}
                className="text-[9px] text-muted-foreground hover:text-foreground"
              >
                全选
              </button>
              <span className="text-[9px] text-muted-foreground">·</span>
              <button
                type="button"
                onClick={() => setSelectedCases(new Set())}
                className="text-[9px] text-muted-foreground hover:text-foreground"
              >
                清空
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-1">
            {EVAL_CASES.map((c) => {
              const sel = selectedCases.has(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => toggleCase(c.id)}
                  className={cn(
                    'flex items-center gap-1 px-1.5 py-1 rounded text-[10px] text-left transition-colors',
                    sel
                      ? 'bg-primary/10 text-primary'
                      : 'bg-muted/50 hover:bg-muted text-muted-foreground',
                  )}
                  title={c.description}
                >
                  {sel ? <CheckSquare size={11} weight="fill" /> : <SquareIcon size={11} />}
                  <span className="truncate">{c.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Presets 多选 */}
        <div>
          <div className="text-[10px] text-muted-foreground tracking-wider font-medium mb-1">
            平滑预设 ({selectedPresets.size}/{ALL_PRESETS.length})
          </div>
          <div className="flex gap-1">
            {ALL_PRESETS.map((p) => {
              const sel = selectedPresets.has(p);
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => togglePreset(p)}
                  title={getStreamingPresetHint(p)}
                  className={cn(
                    'flex-1 px-1.5 py-1 rounded text-[10px] transition-colors',
                    sel
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted/50 hover:bg-muted text-muted-foreground',
                  )}
                >
                  {getStreamingPresetLabel(p)}
                </button>
              );
            })}
          </div>
        </div>

        {/* Rhythm */}
        <div>
          <div className="text-[10px] text-muted-foreground tracking-wider font-medium mb-1">
            输入节奏
          </div>
          <select
            value={rhythmId}
            onChange={(e) => setRhythmId(e.target.value)}
            className="w-full text-[11px] px-2 py-1 rounded bg-muted/50 border border-border text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            disabled={running}
          >
            {RHYTHM_PRESETS.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </div>

        {/* Run / Cancel / Export */}
        <div className="flex gap-1.5 pt-1">
          {!running ? (
            <button
              type="button"
              onClick={handleRun}
              disabled={selectedCases.size === 0 || selectedPresets.size === 0}
              className={cn(
                'flex-1 px-2 py-1.5 text-[11px] rounded flex items-center justify-center gap-1 transition-colors',
                selectedCases.size === 0 || selectedPresets.size === 0
                  ? 'bg-muted text-muted-foreground/50 cursor-not-allowed'
                  : 'bg-primary text-primary-foreground hover:bg-primary/90',
              )}
            >
              <Play size={12} weight="fill" />
              开始评测 ({selectedCases.size}×{selectedPresets.size})
            </button>
          ) : (
            <button
              type="button"
              onClick={handleCancel}
              className="flex-1 px-2 py-1.5 text-[11px] rounded bg-destructive/10 text-destructive hover:bg-destructive/20 flex items-center justify-center gap-1"
            >
              <Stop size={12} weight="fill" />
              取消
            </button>
          )}
          <button
            type="button"
            onClick={handleExport}
            disabled={!report}
            className={cn(
              'px-2 py-1.5 text-[11px] rounded flex items-center justify-center gap-1 transition-colors',
              !report
                ? 'bg-muted text-muted-foreground/50 cursor-not-allowed'
                : 'bg-muted hover:bg-primary/10 hover:text-primary',
            )}
            title="导出报告 JSON"
          >
            <DownloadSimple size={12} />
          </button>
        </div>

        {/* Progress */}
        {running && progress && (
          <div className="space-y-1">
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>
                {progress.current}/{progress.total} · {progress.caseId} · {getStreamingPresetLabel(progress.preset)}
              </span>
              <span>{Math.round((progress.current / progress.total) * 100)}%</span>
            </div>
            <div className="h-1 bg-muted rounded overflow-hidden">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${(progress.current / progress.total) * 100}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* 结果 */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {!report ? (
          <div className="text-[11px] text-muted-foreground text-center py-8 border border-dashed border-border rounded-md">
            选择测试用例与平滑预设后点击「开始评测」
          </div>
        ) : (
          <>
            {/* Preset averages */}
            <div>
              <div className="text-[10px] text-muted-foreground tracking-wider font-medium mb-1">
                预设平均分
              </div>
              <div className="grid grid-cols-2 gap-1">
                {Object.entries(report.presetAverages).map(([p, avg]) => (
                  <div
                    key={p}
                    className="flex items-center justify-between px-2 py-1 rounded bg-muted/40 text-[11px]"
                  >
                    <span className="font-mono text-muted-foreground">{getStreamingPresetLabel(p as StreamingSmoothingPreset)}</span>
                    <span
                      className="font-semibold tabular-nums"
                      style={{ color: scoreToColor(avg) }}
                    >
                      {avg.toFixed(1)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Heatmap */}
            <div>
              <div className="text-[10px] text-muted-foreground tracking-wider font-medium mb-1">
                得分矩阵（点击单元格展开详情）
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[10px]">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="text-left font-medium px-1 py-1 sticky left-0 bg-card">
                        用例
                      </th>
                      {usedPresets.map((p) => (
                        <th key={p} className="text-center font-medium px-1 py-1">
                          {getStreamingPresetLabel(p)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {usedCases.map((cid) => {
                      const caseLabel =
                        EVAL_CASES.find((c) => c.id === cid)?.label ?? cid;
                      return (
                        <tr key={cid} className="border-t border-border/40">
                          <td
                            className="text-left px-1 py-1 truncate max-w-[140px] sticky left-0 bg-card"
                            title={caseLabel}
                          >
                            {caseLabel}
                          </td>
                          {usedPresets.map((p) => {
                            const key = `${cid}::${p}`;
                            const r = matrix?.get(key);
                            if (!r) {
                              return (
                                <td key={p} className="px-0.5 py-0.5 text-center text-muted-foreground">
                                  —
                                </td>
                              );
                            }
                            return (
                              <td key={p} className="px-0.5 py-0.5">
                                <button
                                  type="button"
                                  onClick={() =>
                                    setExpandedKey(expandedKey === key ? null : key)
                                  }
                                  className={cn(
                                    'w-full px-1 py-1 rounded text-center font-mono font-semibold tabular-nums transition-all',
                                    expandedKey === key && 'ring-2 ring-primary',
                                    r.failed && 'opacity-50',
                                  )}
                                  style={{
                                    background: scoreToColor(r.total),
                                    color: '#fff',
                                  }}
                                  title={r.failed ? r.failReason : `${r.total.toFixed(1)}`}
                                >
                                  {r.failed ? '✕' : r.total.toFixed(0)}
                                </button>
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* 详情 */}
            {expandedKey && matrix?.get(expandedKey) && (
              <ResultDetail result={matrix.get(expandedKey)!} />
            )}

            <div className="text-[10px] text-muted-foreground/70 pt-2 border-t border-border/40">
              共 {report.results.length} 次运行 · 耗时 {(report.totalMs / 1000).toFixed(1)}s · 开始于{' '}
              {new Date(report.startedAt).toLocaleTimeString()}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

interface ResultDetailProps {
  result: EvalCaseResult;
}

const ResultDetail: React.FC<ResultDetailProps> = ({ result }) => {
  const m = result.metrics;
  return (
    <div className="rounded-md border border-border bg-muted/30 p-2 space-y-1.5 text-[10px]">
      <div className="flex items-center justify-between">
        <span className="font-medium">
          {result.caseLabel} · <span className="text-muted-foreground">{result.preset}</span>
        </span>
        <span
          className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
          style={{ background: scoreToColor(result.total), color: '#fff' }}
        >
          {result.total.toFixed(1)}
        </span>
      </div>

      <div className="grid grid-cols-4 gap-1">
        <DetailCell label="丝滑度" value={result.scores.smoothness.toFixed(0)} />
        <DetailCell label="响应度" value={result.scores.responsiveness.toFixed(0)} />
        <DetailCell label="吞吐率" value={result.scores.throughput.toFixed(0)} />
        <DetailCell
          label="卡顿扣分"
          value={`-${result.scores.jankPenalty.toFixed(0)}`}
        />
      </div>

      <div className="grid grid-cols-3 gap-1 pt-1 border-t border-border/40">
        <DetailCell label="首字 TTFT" value={m.ttftMs == null ? '—' : `${Math.round(m.ttftMs)}ms`} />
        <DetailCell label="平均 TPS" value={`${m.avgTps}`} />
        <DetailCell label="帧 p95" value={`${m.frameP95}ms`} />
        <DetailCell label="卡顿次数" value={`${m.jankCount}`} />
        <DetailCell label="最大积压" value={`${m.backlogMax}`} />
        <DetailCell label="总耗时" value={`${(m.totalDurationMs / 1000).toFixed(2)}s`} />
      </div>

      {result.failed && (
        <div className="text-destructive text-[10px]">运行失败：{result.failReason}</div>
      )}
    </div>
  );
};

const DetailCell: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex flex-col px-1.5 py-1 rounded bg-card/60">
    <span className="text-[9px] tracking-wider text-muted-foreground">
      {label}
    </span>
    <span className="font-mono font-semibold tabular-nums">{value}</span>
  </div>
);

export default EvalPanel;
