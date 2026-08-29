/**
 * HpiasStore 快照 → research-plan 步骤映射（Research #7 实时接线 POC）
 */
import type { ResearchPlanStepInput } from './buildResearchPlanIntent';

export type HpiasSubAgentStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface HpiasSubAgentSnapshot {
  status: HpiasSubAgentStatus;
  query?: string;
}

/** 映射所需的最小 HpiasStore 快照（纯函数，便于单测） */
export interface HpiasResearchSnapshot {
  sessionId: string | null;
  round: number;
  plan: unknown;
  synthesis: string | null;
  retrievalCount: number | null;
  selectedCount: number | null;
  subAgents: Record<number, HpiasSubAgentSnapshot>;
  roundStatus?: string;
}

export interface HpiasResearchPlanLabels {
  stepPlan: string;
  stepRetrieval: string;
  stepSelection: string;
  stepSubagents: string;
  stepSynthesis: string;
  subagentFallback: string;
}

const MAX_PLAN_STEPS = 12;

function extractPlanQueries(plan: unknown): string[] {
  if (!plan || typeof plan !== 'object') return [];
  const core = (plan as { core?: { queries?: unknown } }).core;
  if (!Array.isArray(core?.queries)) return [];
  return core.queries.filter((q): q is string => typeof q === 'string' && q.trim().length > 0);
}

function mapSubAgentStatus(status: HpiasSubAgentStatus): ResearchPlanStepInput['status'] {
  switch (status) {
    case 'completed':
    case 'failed':
      return 'done';
    case 'running':
      return 'active';
    default:
      return 'pending';
  }
}

function hasRunningSubAgent(subAgents: Record<number, HpiasSubAgentSnapshot>): boolean {
  return Object.values(subAgents).some((sub) => sub.status === 'running');
}

function allSubAgentsDone(subAgents: Record<number, HpiasSubAgentSnapshot>): boolean {
  const entries = Object.values(subAgents);
  return entries.length > 0 && entries.every((sub) => sub.status === 'completed' || sub.status === 'failed');
}

/** 从 HpiasStore 快照推导 research-plan 步骤列表 */
export function mapHpiasStoreToResearchPlanSteps(
  snapshot: HpiasResearchSnapshot,
  labels: HpiasResearchPlanLabels,
): ResearchPlanStepInput[] {
  const steps: ResearchPlanStepInput[] = [];

  steps.push({
    label: labels.stepPlan,
    status: snapshot.plan ? 'done' : snapshot.sessionId ? 'active' : 'pending',
  });

  steps.push({
    label: labels.stepRetrieval,
    status:
      snapshot.retrievalCount != null
        ? 'done'
        : snapshot.plan
          ? 'active'
          : 'pending',
  });

  steps.push({
    label: labels.stepSelection,
    status:
      snapshot.selectedCount != null
        ? 'done'
        : snapshot.retrievalCount != null
          ? 'active'
          : 'pending',
  });

  const subEntries = Object.entries(snapshot.subAgents).sort(
    ([a], [b]) => Number(a) - Number(b),
  );

  if (subEntries.length > 0) {
    for (const [id, sub] of subEntries) {
      steps.push({
        label: sub.query?.trim() || labels.subagentFallback.replace('{{id}}', id),
        status: mapSubAgentStatus(sub.status),
      });
    }
  } else {
    const queries = extractPlanQueries(snapshot.plan);
    if (queries.length > 0) {
      const subagentsActive = snapshot.selectedCount != null && !snapshot.synthesis;
      for (const query of queries) {
        steps.push({
          label: query,
          status: subagentsActive ? 'active' : snapshot.selectedCount != null ? 'pending' : 'pending',
        });
      }
    } else {
      steps.push({
        label: labels.stepSubagents,
        status: allSubAgentsDone(snapshot.subAgents)
          ? 'done'
          : hasRunningSubAgent(snapshot.subAgents) || snapshot.roundStatus === 'executing'
            ? 'active'
            : snapshot.selectedCount != null
              ? 'pending'
              : 'pending',
      });
    }
  }

  steps.push({
    label: labels.stepSynthesis,
    status: snapshot.synthesis?.trim()
      ? 'done'
      : hasRunningSubAgent(snapshot.subAgents) || snapshot.roundStatus === 'streaming'
        ? 'active'
        : allSubAgentsDone(snapshot.subAgents)
          ? 'active'
          : 'pending',
  });

  return steps.slice(0, MAX_PLAN_STEPS);
}

/** 从 useHpiasStore 状态构造快照 */
export function pickHpiasResearchSnapshot(state: {
  sessionId: string | null;
  round: number;
  plan: unknown;
  synthesis: string | null;
  retrievalCount: number | null;
  selectedCount: number | null;
  subAgents: Record<number, HpiasSubAgentSnapshot>;
  roundsView: Record<number, { status?: string }>;
}): HpiasResearchSnapshot {
  const roundStatus = state.roundsView[state.round]?.status;
  return {
    sessionId: state.sessionId,
    round: state.round,
    plan: state.plan,
    synthesis: state.synthesis,
    retrievalCount: state.retrievalCount,
    selectedCount: state.selectedCount,
    subAgents: state.subAgents,
    roundStatus,
  };
}
