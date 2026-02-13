/**
 * 测试时间线合并与阶段耗时统计工具
 */

import type { Snapshot, SnapshotLayer } from './testSnapshot';

export interface TimelineEntry {
  ts: number;
  layer: SnapshotLayer;
  event: string;
  duration?: number;
  data?: any;
  stepId?: string;
  phase?: string;
}

export interface PhaseTiming {
  phase: string;
  startTime: number;
  endTime: number;
  duration: number;
  snapshotCount: number;
  errorCount: number;
}

export interface TimelineAnalysis {
  entries: TimelineEntry[];
  phases: PhaseTiming[];
  totalDuration: number;
  averagePhaseDuration: number;
  slowestPhase: PhaseTiming | null;
  fastestPhase: PhaseTiming | null;
}

/**
 * 合并快照为时间线
 */
export function mergeSnapshotsToTimeline(
  snapshots: Snapshot[],
  logs?: Array<{ ts: number; stepId?: string }>
): TimelineEntry[] {
  const timeline: TimelineEntry[] = [];
  const stepIdMap = new Map<number, string>();

  // 建立时间戳到stepId的映射
  if (logs) {
    logs.forEach(log => {
      if (log.stepId && log.ts) {
        stepIdMap.set(log.ts, log.stepId);
      }
    });
  }

  // 将快照转换为时间线条目
  snapshots.forEach(snapshot => {
    const entry: TimelineEntry = {
      ts: snapshot.ts,
      layer: snapshot.layer,
      event: getEventName(snapshot),
      data: snapshot.data,
      stepId: snapshot.stepId || stepIdMap.get(snapshot.ts),
      phase: determinePhase(snapshot),
    };

    timeline.push(entry);
  });

  // 按时间戳排序
  timeline.sort((a, b) => a.ts - b.ts);

  // 计算持续时间（相邻条目的时间差）
  for (let i = 1; i < timeline.length; i++) {
    timeline[i].duration = timeline[i].ts - timeline[i - 1].ts;
  }

  return timeline;
}

/**
 * 从快照中提取事件名称
 */
function getEventName(snapshot: Snapshot): string {
  if (snapshot.layer === 'event' && snapshot.data?.event) {
    return snapshot.data.event;
  }
  if (snapshot.layer === 'invoke' && snapshot.data?.cmd) {
    return `invoke:${snapshot.data.cmd}`;
  }
  if (snapshot.layer === 'runtime' && snapshot.data?.phase) {
    return `runtime:${snapshot.data.phase}`;
  }
  if (snapshot.layer === 'ui') {
    return 'ui:snapshot';
  }
  if (snapshot.layer === 'metrics') {
    return 'metrics:snapshot';
  }
  return `${snapshot.layer}:unknown`;
}

/**
 * 确定快照所属的阶段
 */
function determinePhase(snapshot: Snapshot): string {
  if (snapshot.layer === 'runtime' && snapshot.data?.phase) {
    return snapshot.data.phase;
  }
  if (snapshot.layer === 'event') {
    if (snapshot.data?.event === 'CHAT_STREAM_COMPLETE') {
      return 'stream_complete';
    }
    if (snapshot.data?.event === 'CHAT_SAVE_COMPLETE') {
      return 'save_complete';
    }
  }
  if (snapshot.layer === 'invoke') {
    return 'backend_call';
  }
  if (snapshot.layer === 'ui') {
    return 'ui_interaction';
  }
  return 'unknown';
}

/**
 * 分析时间线并提取阶段耗时统计
 */
export function analyzeTimeline(timeline: TimelineEntry[]): TimelineAnalysis {
  if (timeline.length === 0) {
    return {
      entries: [],
      phases: [],
      totalDuration: 0,
      averagePhaseDuration: 0,
      slowestPhase: null,
      fastestPhase: null,
    };
  }

  // 按阶段分组
  const phaseMap = new Map<string, { entries: TimelineEntry[]; startTime: number; endTime: number }>();

  timeline.forEach(entry => {
    const phase = entry.phase || 'unknown';
    if (!phaseMap.has(phase)) {
      phaseMap.set(phase, {
        entries: [],
        startTime: entry.ts,
        endTime: entry.ts,
      });
    }

    const phaseData = phaseMap.get(phase)!;
    phaseData.entries.push(entry);
    phaseData.startTime = Math.min(phaseData.startTime, entry.ts);
    phaseData.endTime = Math.max(phaseData.endTime, entry.ts);
  });

  // 转换为阶段耗时数组
  const phases: PhaseTiming[] = Array.from(phaseMap.entries()).map(([phase, data]) => {
    const duration = data.endTime - data.startTime;
    const errorCount = data.entries.filter(e => e.data?.error).length;

    return {
      phase,
      startTime: data.startTime,
      endTime: data.endTime,
      duration,
      snapshotCount: data.entries.length,
      errorCount,
    };
  });

  // 计算统计信息
  const startTime = timeline[0].ts;
  const endTime = timeline[timeline.length - 1].ts;
  const totalDuration = endTime - startTime;
  const averagePhaseDuration = phases.length > 0
    ? phases.reduce((sum, p) => sum + p.duration, 0) / phases.length
    : 0;

  const slowestPhase = phases.length > 0
    ? phases.reduce((max, p) => (p.duration > max.duration ? p : max), phases[0])
    : null;

  const fastestPhase = phases.length > 0
    ? phases.reduce((min, p) => (p.duration < min.duration ? p : min), phases[0])
    : null;

  return {
    entries: timeline,
    phases,
    totalDuration,
    averagePhaseDuration,
    slowestPhase,
    fastestPhase,
  };
}

/**
 * 生成时间线摘要文本
 */
export function generateTimelineSummary(analysis: TimelineAnalysis): string {
  const lines: string[] = [];
  lines.push(`总耗时: ${analysis.totalDuration}ms`);
  lines.push(`平均阶段耗时: ${analysis.averagePhaseDuration.toFixed(2)}ms`);
  
  if (analysis.slowestPhase) {
    lines.push(`最慢阶段: ${analysis.slowestPhase.phase} (${analysis.slowestPhase.duration}ms)`);
  }
  
  if (analysis.fastestPhase) {
    lines.push(`最快阶段: ${analysis.fastestPhase.phase} (${analysis.fastestPhase.duration}ms)`);
  }

  lines.push('\n阶段详情:');
  analysis.phases.forEach(phase => {
    lines.push(`  ${phase.phase}: ${phase.duration}ms (${phase.snapshotCount}个快照, ${phase.errorCount}个错误)`);
  });

  return lines.join('\n');
}

