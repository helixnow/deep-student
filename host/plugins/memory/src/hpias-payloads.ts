/**
 * HPIAS event payload builders — TS mirror of `dstu-research/src/hpias/payloads.rs`.
 *
 * The payloads are plain JSON with snake_case keys, matching the frontend
 * `HpiasEvent` union exactly (see `docs/generative-ui/ARCHITECTURE.md`).
 */
import { rustTrim } from '../../../platform/util/portable.ts';

export const HPIAS_EVENT_CHANNEL = 'hpias_event';
export const RESEARCH_BLOCK_TYPES = ['research-plan', 'research-report', 'paper-digest'] as const;
export const MAX_RESEARCH_PLAN_QUERIES = 12;

export type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}
function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}
function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
function nonBlank(value: unknown): string | null {
  const raw = asString(value);
  const text = raw === null ? undefined : rustTrim(raw);
  return text !== undefined && text.length > 0 ? text : null;
}
function blocksOf(intent: unknown): unknown[] {
  return asArray(asRecord(intent)?.['blocks']) ?? [];
}

/** 与前端 `intentHasResearchBlocks` 对齐。 */
export function intentHasResearchBlocks(intent: unknown): boolean {
  return blocksOf(intent).some(block =>
    (RESEARCH_BLOCK_TYPES as readonly string[]).includes(asString(asRecord(block)?.['type']) ?? ''));
}

/** 从 intent 提取研究问题（meta.title 或首个 research-plan.props.title）。 */
export function extractQuestionFromIntent(intent: unknown): string | null {
  const metaTitle = nonBlank(asRecord(asRecord(intent)?.['meta'])?.['title']);
  if (metaTitle !== null) return metaTitle;
  for (const block of blocksOf(intent)) {
    const record = asRecord(block);
    if (asString(record?.['type']) !== 'research-plan') continue;
    const title = nonBlank(asRecord(record?.['props'])?.['title']);
    if (title !== null) return title;
  }
  return null;
}

/** 从首个非空 research-plan 块提取去重后的 subagent 查询词（上限 12）。 */
export function extractPlanQueriesFromIntent(intent: unknown): string[] {
  for (const block of blocksOf(intent)) {
    const record = asRecord(block);
    if (asString(record?.['type']) !== 'research-plan') continue;
    const steps = asArray(asRecord(record?.['props'])?.['steps']);
    if (steps === null) continue;
    const seen = new Set<string>();
    const queries: string[] = [];
    for (const step of steps) {
      const label = nonBlank(asRecord(step)?.['label']);
      if (label === null || seen.has(label)) continue;
      seen.add(label);
      queries.push(label);
      if (queries.length >= MAX_RESEARCH_PLAN_QUERIES) break;
    }
    if (queries.length > 0) return queries;
  }
  return [];
}

/** 从 research-report 块提取 synthesis 正文。 */
export function extractSynthesisFromIntent(intent: unknown): string | null {
  for (const block of blocksOf(intent)) {
    const record = asRecord(block);
    if (asString(record?.['type']) !== 'research-report') continue;
    const body = nonBlank(asRecord(record?.['props'])?.['body']);
    if (body !== null) return body;
  }
  return null;
}

export function buildSessionStartedPayload(sessionId: string, question: string | null | undefined,
  optionsJson: string | null | undefined): JsonRecord {
  const payload: JsonRecord = { type: 'session_started', session_id: sessionId };
  const trimmedQuestion = question == null ? undefined : rustTrim(question);
  if (trimmedQuestion !== undefined && trimmedQuestion.length > 0) {
    payload['question'] = trimmedQuestion;
  }
  const trimmedOptions = optionsJson == null ? undefined : rustTrim(optionsJson);
  if (trimmedOptions !== undefined && trimmedOptions.length > 0) {
    payload['options_json'] = trimmedOptions;
  }
  return payload;
}

export function buildRoundStartedPayload(sessionId: string, round: number): JsonRecord {
  return { type: 'round_started', session_id: sessionId, round };
}

export function buildPlanGeneratedPayload(sessionId: string, round: number,
  plan: unknown): JsonRecord {
  return { type: 'plan_generated', session_id: sessionId, round, plan };
}

export function buildRetrievalCompletedPayload(sessionId: string, round: number,
  fetched: number): JsonRecord {
  return { type: 'retrieval_completed', session_id: sessionId, round, fetched };
}

export function buildSelectionCompletedPayload(sessionId: string, round: number,
  selected: number, citations: unknown): JsonRecord {
  const payload: JsonRecord = {
    type: 'selection_completed', session_id: sessionId, round, selected,
  };
  if (citations !== null && citations !== undefined) payload['citations'] = citations;
  return payload;
}

export function buildSubagentStartedPayload(sessionId: string, round: number, subId: number,
  query: string): JsonRecord {
  return {
    type: 'subagent_started', session_id: sessionId, round, sub_id: subId, query,
  };
}

export function buildSubagentCompletedPayload(sessionId: string, round: number, subId: number,
  steps: number, summaryMd: string, citations: unknown): JsonRecord {
  return {
    type: 'subagent_completed', session_id: sessionId, round, sub_id: subId, steps,
    summary_md: summaryMd, citations,
  };
}

export function buildSynthesisUpdatedPayload(sessionId: string, round: number,
  synthesis: string): JsonRecord {
  return { type: 'synthesis_updated', session_id: sessionId, round, synthesis };
}

export function buildSubagentsDonePayload(sessionId: string, round: number, metrics: unknown,
  subReports: unknown): JsonRecord {
  return {
    type: 'subagents_done', session_id: sessionId, round, metrics, sub_reports: subReports,
  };
}

export function buildSessionCompletedPayload(sessionId: string, round: number): JsonRecord {
  return { type: 'session_completed', session_id: sessionId, round };
}

const DEFAULT_TIMELINE_QUERIES = [
  '2024-2026 医学影像深度学习综述',
  'FDA 批准的 AI 影像诊断产品',
];
const DEFAULT_SYNTHESIS =
  '## 综合结论\n\n深度学习在医学影像领域持续向 **多模态融合** 与 **可解释性** 演进 [review-1]。';

/** 完整 stub pipeline 时间线（对齐 Style Lab `buildStyleLabHpiasDemoTimeline`）。 */
export function buildPipelineTimeline(sessionId: string, question: string | null | undefined,
  intent: unknown): JsonRecord[] {
  const round = 1;
  const fromIntent = intent === null || intent === undefined
    ? [] : extractPlanQueriesFromIntent(intent);
  const queries = fromIntent.length > 0 ? fromIntent : [...DEFAULT_TIMELINE_QUERIES];
  const synthesis = (intent === null || intent === undefined
    ? null : extractSynthesisFromIntent(intent)) ?? DEFAULT_SYNTHESIS;

  const plan = { core: { queries: [...queries] } };
  const fetched = Math.max(queries.length * 21, 12);
  const selected = Math.max(queries.length * 6, 6);

  const timeline: JsonRecord[] = [
    buildSessionStartedPayload(sessionId, question, '{"execution_mode":"autonomous"}'),
    buildRoundStartedPayload(sessionId, round),
    buildPlanGeneratedPayload(sessionId, round, plan),
    buildRetrievalCompletedPayload(sessionId, round, fetched),
    buildSelectionCompletedPayload(sessionId, round, selected, { items: [] }),
  ];

  for (const [index, query] of queries.entries()) {
    const subId = index + 1;
    timeline.push(buildSubagentStartedPayload(sessionId, round, subId, query));
    if (index === 0) {
      timeline.push(buildSynthesisUpdatedPayload(sessionId, round, synthesis));
    }
    timeline.push(buildSubagentCompletedPayload(sessionId, round, subId, 3,
      `子代理 ${subId} 已完成检索与摘要。`, [[`paper-${subId}`, subId]]));
  }

  timeline.push(buildSubagentsDonePayload(sessionId, round, { completed: queries.length }, []));
  timeline.push(buildSessionCompletedPayload(sessionId, round));
  return timeline;
}
