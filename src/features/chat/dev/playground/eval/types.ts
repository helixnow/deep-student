/**
 * Evaluation types
 */

import type { StreamingSmoothingPreset } from '@/features/chat/components/renderers/streamingSmoothing';
import type {
  StreamingMetricsSnapshot,
  MetricsTimePoint,
} from '@/features/chat/components/renderers/streamingMetrics';
import type { StreamingMarkdownProfilerEvent } from '@/features/chat/components/renderers/streamingProfiler';

export type RhythmStrategy =
  | { type: 'fixed'; chunkSize: number; delayMs: number }
  | { type: 'poisson'; meanCps: number; jitter: number; seed?: number }
  | { type: 'burst'; burstSize: number; burstGapMs: number; idleMs: number }
  | { type: 'replay'; events: StreamingMarkdownProfilerEvent[] };

export interface EvalCase {
  id: string;
  label: string;
  description: string;
  /** 完整 markdown 文本（喂给模拟流式） */
  source: string;
  /** 期望吞吐量目标，用于评分 throughput 子项 */
  targetCps?: number;
}

export interface EvalConfig {
  cases: EvalCase[];
  presets: StreamingSmoothingPreset[];
  rhythm: RhythmStrategy;
  /** 单个 case 的硬超时（ms），防卡死 */
  caseTimeoutMs?: number;
}

export interface EvalSubScores {
  /** 帧 p95 越低越好 */
  smoothness: number;
  /** TTFT 越低越好 */
  responsiveness: number;
  /** avgTps 接近目标越好 */
  throughput: number;
  /** jank 惩罚（已减去） */
  jankPenalty: number;
}

export interface EvalCaseResult {
  caseId: string;
  caseLabel: string;
  preset: StreamingSmoothingPreset;
  metrics: StreamingMetricsSnapshot;
  series: MetricsTimePoint[];
  scores: EvalSubScores;
  /** 总分 0–100 */
  total: number;
  /** 是否超时/失败 */
  failed: boolean;
  failReason?: string;
  durationMs: number;
}

export interface EvalReport {
  startedAt: string;
  finishedAt: string;
  totalMs: number;
  rhythm: RhythmStrategy;
  results: EvalCaseResult[];
  /** 每个 preset 的平均总分 */
  presetAverages: Record<string, number>;
}
