/**
 * HPIAS 多会话切片：Chat 中多个 researchSessionId 可并行保活。
 * 活跃会话仍写 store 顶层字段；外会话事件只更新 sessions[id]。
 */
import type { HpiasEvent } from './researchStore';

export const MAX_HPIAS_SESSION_SLICES = 8;

export type HpiasSliceSubAgentStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface HpiasSliceSubAgent {
  status: HpiasSliceSubAgentStatus;
  query?: string;
}

export interface HpiasSessionSlice {
  sessionId: string;
  round: number;
  plan: unknown | null;
  synthesis: string | null;
  retrievalCount: number | null;
  selectedCount: number | null;
  subAgents: Record<number, HpiasSliceSubAgent>;
  roundsView: Record<number, { status?: string }>;
  updatedAt: number;
}

export function createEmptyHpiasSessionSlice(sessionId: string): HpiasSessionSlice {
  return {
    sessionId,
    round: 0,
    plan: null,
    synthesis: null,
    retrievalCount: null,
    selectedCount: null,
    subAgents: {},
    roundsView: {},
    updatedAt: Date.now(),
  };
}

export function pickHpiasSessionSliceFromStore(state: {
  sessionId: string | null;
  round: number;
  plan: unknown;
  synthesis: string | null;
  retrievalCount: number | null;
  selectedCount: number | null;
  subAgents: Record<number, { status: HpiasSliceSubAgentStatus; query?: string }>;
  roundsView: Record<number, { status?: string }>;
}): HpiasSessionSlice | null {
  if (!state.sessionId) return null;
  const subAgents: Record<number, HpiasSliceSubAgent> = {};
  for (const [key, value] of Object.entries(state.subAgents)) {
    subAgents[Number(key)] = { status: value.status, query: value.query };
  }
  const roundsView: Record<number, { status?: string }> = {};
  for (const [key, value] of Object.entries(state.roundsView)) {
    roundsView[Number(key)] = { status: value.status };
  }
  return {
    sessionId: state.sessionId,
    round: state.round,
    plan: state.plan,
    synthesis: state.synthesis,
    retrievalCount: state.retrievalCount,
    selectedCount: state.selectedCount,
    subAgents,
    roundsView,
    updatedAt: Date.now(),
  };
}

function readEventSessionId(event: HpiasEvent): string | undefined {
  return 'session_id' in event && typeof event.session_id === 'string' && event.session_id
    ? event.session_id
    : undefined;
}

function touch(slice: HpiasSessionSlice, patch: Partial<HpiasSessionSlice>): HpiasSessionSlice {
  return { ...slice, ...patch, sessionId: slice.sessionId, updatedAt: Date.now() };
}

function setRoundStatus(
  slice: HpiasSessionSlice,
  round: number,
  status: string,
): Record<number, { status?: string }> {
  return {
    ...slice.roundsView,
    [round]: { ...slice.roundsView[round], status },
  };
}

/** 将单条 HPIAS 事件折叠进指定会话切片（外会话与活跃会话共用）。 */
export function applyHpiasEventToSessionSlice(
  slice: HpiasSessionSlice,
  event: HpiasEvent,
): HpiasSessionSlice {
  const eventSessionId = readEventSessionId(event);
  if (eventSessionId && eventSessionId !== slice.sessionId) {
    return slice;
  }

  switch (event.type) {
    case 'session_started':
      return createEmptyHpiasSessionSlice(slice.sessionId);
    case 'round_started':
      return touch(slice, {
        round: event.round,
        plan: null,
        synthesis: null,
        retrievalCount: null,
        selectedCount: null,
        subAgents: {},
        roundsView: setRoundStatus(slice, event.round, 'started'),
      });
    case 'round_executing':
      return touch(slice, {
        roundsView: setRoundStatus(slice, event.round, 'executing'),
      });
    case 'plan_pending_approval':
      return touch(slice, {
        round: event.round,
        plan: event.plan,
        roundsView: setRoundStatus(slice, event.round, 'pending_approval'),
      });
    case 'plan_generated':
      return touch(slice, {
        round: event.round,
        plan: event.plan,
        roundsView: setRoundStatus(slice, event.round, slice.roundsView[event.round]?.status || 'started'),
      });
    case 'retrieval_completed':
      return touch(slice, {
        round: event.round,
        retrievalCount: event.fetched,
      });
    case 'selection_completed':
      return touch(slice, {
        round: event.round,
        selectedCount: event.selected,
        roundsView: setRoundStatus(slice, event.round, 'retrieved'),
      });
    case 'subagent_started':
      return touch(slice, {
        subAgents: {
          ...slice.subAgents,
          [event.sub_id]: { status: 'running', query: event.query },
        },
      });
    case 'subagent_completed':
      return touch(slice, {
        subAgents: {
          ...slice.subAgents,
          [event.sub_id]: {
            status: 'completed',
            query: slice.subAgents[event.sub_id]?.query,
          },
        },
      });
    case 'subagent_failed':
      return touch(slice, {
        subAgents: {
          ...slice.subAgents,
          [event.sub_id]: {
            status: 'failed',
            query: slice.subAgents[event.sub_id]?.query,
          },
        },
      });
    case 'synthesis_updated':
      return touch(slice, {
        round: event.round,
        synthesis: `${slice.synthesis ?? ''}${event.synthesis ?? ''}`,
        roundsView: setRoundStatus(slice, event.round, 'streaming'),
      });
    case 'session_completed':
      return touch(slice, {
        roundsView: setRoundStatus(slice, event.round, 'completed'),
      });
    case 'session_failed':
      return touch(slice, {
        subAgents: Object.fromEntries(
          Object.entries(slice.subAgents).map(([key, value]) => [
            Number(key),
            value.status === 'running' || value.status === 'pending'
              ? { ...value, status: 'failed' as const }
              : value,
          ]),
        ),
      });
    default:
      return touch(slice, {});
  }
}

export function pruneHpiasSessionSlices(
  sessions: Record<string, HpiasSessionSlice>,
  protectIds: Array<string | null | undefined>,
  max = MAX_HPIAS_SESSION_SLICES,
): Record<string, HpiasSessionSlice> {
  const ids = Object.keys(sessions);
  if (ids.length <= max) return sessions;

  const protect = new Set(protectIds.filter((id): id is string => Boolean(id)));
  const droppable = ids
    .filter((id) => !protect.has(id))
    .sort((a, b) => sessions[a].updatedAt - sessions[b].updatedAt);

  const overflow = ids.length - max;
  if (overflow <= 0 || droppable.length === 0) return sessions;

  const next = { ...sessions };
  for (const id of droppable.slice(0, overflow)) {
    delete next[id];
  }
  return next;
}
