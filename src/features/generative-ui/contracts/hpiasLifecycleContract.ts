/**
 * HPIAS pipeline 生命周期事件契约 — Rust payloads / Style Lab demo / 前端 store 共用
 *
 * 顺序必须与 `src-tauri/src/hpias/payloads.rs::build_pipeline_timeline` 及
 * `styleLabHpiasDemo.ts::buildStyleLabHpiasDemoTimeline` 一致。
 */
export const HPIAS_PIPELINE_LIFECYCLE = [
  'session_started',
  'round_started',
  'plan_generated',
  'retrieval_completed',
  'selection_completed',
  'subagent_started',
  'synthesis_updated',
  'subagent_completed',
  'subagents_done',
  'session_completed',
] as const;

export type HpiasPipelineLifecycleType = (typeof HPIAS_PIPELINE_LIFECYCLE)[number];

/** Style Lab 演示时间线必须覆盖的核心生命周期（允许重复 subagent_*） */
export const HPIAS_REQUIRED_LIFECYCLE_TYPES: readonly HpiasPipelineLifecycleType[] = [
  'session_started',
  'round_started',
  'plan_generated',
  'retrieval_completed',
  'selection_completed',
  'subagent_started',
  'subagent_completed',
  'synthesis_updated',
  'subagents_done',
  'session_completed',
];

/** 从事件列表提取 type 序列 */
export function extractHpiasEventTypes(events: ReadonlyArray<{ type: string }>): string[] {
  return events.map((e) => e.type);
}

/** 验证事件序列包含所有必需生命周期类型 */
export function assertHpiasLifecycleCoverage(eventTypes: string[]): void {
  for (const required of HPIAS_REQUIRED_LIFECYCLE_TYPES) {
    if (!eventTypes.includes(required)) {
      throw new Error(`Missing HPIAS lifecycle event: ${required}`);
    }
  }
}
