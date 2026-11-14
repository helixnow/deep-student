/** Pure projections: callers own subscriptions and the independent 1 Hz clock. */
export type SidebarActivityState =
  | 'permission' | 'waiting_input' | 'evaluating_goal'
  | 'running_main' | 'running_subagent' | 'running_shell' | 'running_workflow'
  | 'zombie' | 'unread' | 'idle';

export interface SessionActivity {
  id: string;
  parentId?: string;
  children?: readonly string[];
  permission?: boolean;
  waitingInput?: boolean;
  waitingQuestion?: boolean;
  waitingPage?: boolean;
  waitingSecret?: boolean;
  evaluatingGoal?: boolean;
  runningMain?: boolean;
  runningSubagent?: boolean;
  runningShell?: boolean;
  runningWorkflow?: boolean;
  zombie?: boolean;
  unread?: boolean;
  startedAt?: number;
}

export interface SidebarActivityResult {
  state: SidebarActivityState;
  bubbledFromSessionId?: string;
  icon: string;
  tone: 'warning' | 'info' | 'success' | 'muted';
  timerIntervalMs: 1000 | null;
  startedAt?: number;
}

const states: readonly SidebarActivityState[] = [
  'permission', 'waiting_input', 'evaluating_goal', 'running_main',
  'running_subagent', 'running_shell', 'running_workflow', 'zombie', 'unread', 'idle',
];
const icons: Record<SidebarActivityState, string> = {
  permission: 'shield', waiting_input: 'message-question', evaluating_goal: 'scan',
  running_main: 'circle', running_subagent: 'robot', running_shell: 'terminal',
  running_workflow: 'workflow', zombie: 'triangle-alert', unread: 'circle-check', idle: 'circle',
};

function ownState(session: SessionActivity | undefined): SidebarActivityState {
  if (!session) return 'idle';
  if (session.permission) return 'permission';
  if (session.waitingInput || session.waitingQuestion || session.waitingPage || session.waitingSecret) return 'waiting_input';
  if (session.evaluatingGoal) return 'evaluating_goal';
  if (session.runningMain) return 'running_main';
  if (session.runningSubagent) return 'running_subagent';
  if (session.runningShell) return 'running_shell';
  if (session.runningWorkflow) return 'running_workflow';
  if (session.zombie) return 'zombie';
  return session.unread ? 'unread' : 'idle';
}

function presentation(state: SidebarActivityState, startedAt?: number): SidebarActivityResult {
  const running = state.startsWith('running_');
  return {
    state, icon: icons[state],
    tone: state === 'permission' || state === 'waiting_input' || state === 'zombie'
      ? 'warning' : state === 'unread' ? 'success' : state === 'idle' ? 'muted' : 'info',
    timerIntervalMs: running ? 1000 : null,
    ...(running && startedAt !== undefined ? { startedAt } : {}),
  };
}

/** Only blocking descendants override the row's own state; cycles are visited once. */
export function resolveSessionSidebarActivityState(
  sessionId: string,
  sessionMap: ReadonlyMap<string, SessionActivity>,
): SidebarActivityResult {
  const root = sessionMap.get(sessionId);
  let result = presentation(ownState(root), root?.startedAt);
  const visited = new Set<string>([sessionId]);
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const session = sessionMap.get(id);
    const state = ownState(session);
    if ((state === 'permission' || state === 'waiting_input') && states.indexOf(state) < states.indexOf(result.state)) {
      result = { ...presentation(state), bubbledFromSessionId: id };
    }
    for (const child of childrenOf(id, sessionMap)) visit(child);
  };
  for (const child of childrenOf(sessionId, sessionMap)) visit(child);
  return result;
}

function childrenOf(id: string, sessions: ReadonlyMap<string, SessionActivity>): string[] {
  const children = new Set(sessions.get(id)?.children ?? []);
  for (const session of sessions.values()) if (session.parentId === id) children.add(session.id);
  return [...children];
}

/** Folded project groups use exactly the row priority and preserve blocking provenance. */
export function resolveProjectSidebarActivityState(
  rootSessionIds: readonly string[], sessionMap: ReadonlyMap<string, SessionActivity>,
): SidebarActivityResult {
  let result = presentation('idle');
  for (const id of rootSessionIds) {
    const next = resolveSessionSidebarActivityState(id, sessionMap);
    if (states.indexOf(next.state) < states.indexOf(result.state)) {
      result = next.state === 'permission' || next.state === 'waiting_input'
        ? { ...next, bubbledFromSessionId: next.bubbledFromSessionId ?? id } : next;
    }
  }
  return result;
}

export function resolveSessionRowQuickAction(isShiftPressed: boolean): 'archive' | 'delete_permanent' {
  return isShiftPressed ? 'delete_permanent' : 'archive';
}

export interface TokenUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}
export interface ContextUsageMessage {
  role: string;
  tokens?: TokenUsage;
  /** A completed compaction boundary, not the summarizer's usage report. */
  compacted?: boolean;
  /** For callers that have trimmed the boundary out of their message history. */
  afterCompaction?: boolean;
}
export type HonestContextUsage = {
  state: 'measured'; totalTokens: number; limit: number; percent: number; displayPercent: string;
} | { state: 'compacted' | 'unknown'; limit: number; percent: null; displayPercent: '—' };

const tokenTotal = (usage: TokenUsage = {}): number =>
  (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) + (usage.output ?? 0);

/** Never sum round trips. With no boundary, just-compacted history needs an explicit new-report marker. */
export function computeHonestSessionContextUsage(
  messages: readonly ContextUsageMessage[], contextLimit: number, isJustCompacted: boolean,
): HonestContextUsage {
  const limit = Number.isFinite(contextLimit) && contextLimit > 0 ? contextLimit : 200_000;
  let boundary = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].compacted === true) { boundary = index; break; }
  }
  for (let index = messages.length - 1; index > boundary; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    if (isJustCompacted && boundary < 0 && !message.afterCompaction) continue;
    const totalTokens = tokenTotal(message.tokens);
    if (totalTokens <= 0) continue;
    const percent = totalTokens / limit * 100;
    return { state: 'measured', totalTokens, limit, percent, displayPercent: `${Math.round(percent)}%` };
  }
  return { state: isJustCompacted || boundary >= 0 ? 'compacted' : 'unknown', limit, percent: null, displayPercent: '—' };
}

export interface TurnTelemetry extends TokenUsage {
  startedAt?: number;
  endedAt?: number;
  /** Measured final text delivery interval, not whole-turn or tool-loop duration. */
  responseDurationMs?: number;
  responseTokens?: number;
  steps?: readonly { llmDurationMs?: number; toolDurationMs?: number; ttftMs?: number; output?: number }[];
}

export function computeTurnTelemetryBreakdown(turn: TurnTelemetry) {
  const steps = turn.steps ?? [];
  const sum = (key: 'llmDurationMs' | 'toolDurationMs'): number | null => {
    const values = steps.flatMap((step) => step[key] === undefined ? [] : [step[key]]);
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  const llmDurationMs = sum('llmDurationMs');
  const ttfts = steps.flatMap((step) => step.ttftMs === undefined ? [] : [step.ttftMs]);
  const prompt = (turn.input ?? 0) + (turn.cacheRead ?? 0) + (turn.cacheWrite ?? 0);
  return {
    elapsedMs: turn.startedAt !== undefined && turn.endedAt !== undefined ? Math.max(0, turn.endedAt - turn.startedAt) : null,
    llmDurationMs,
    toolDurationMs: sum('toolDurationMs'),
    avgTtftMs: ttfts.length ? ttfts.reduce((total, value) => total + value, 0) / ttfts.length : null,
    responseTokensPerSec: turn.responseDurationMs !== undefined && turn.responseDurationMs > 0
      && (turn.responseTokens ?? turn.output) !== undefined
      ? (turn.responseTokens ?? turn.output ?? 0) / turn.responseDurationMs * 1000 : null,
    cacheHitRate: prompt > 0 ? Math.max(0, Math.min(1, (turn.cacheRead ?? 0) / prompt)) : null,
  };
}

export interface SessionCostRecord extends SessionActivity {
  tokens?: TokenUsage;
  cost?: number;
}

export function computeSubtreeCostAndTokens(rootSessionId: string, sessionMap: ReadonlyMap<string, SessionCostRecord>) {
  const visited = new Set<string>();
  let totalTokens = 0;
  let totalCost = 0;
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const session = sessionMap.get(id);
    totalTokens += tokenTotal(session?.tokens);
    totalCost += session?.cost ?? 0;
    for (const child of childrenOf(id, sessionMap)) visit(child);
  };
  visit(rootSessionId);
  return { totalTokens, totalCost: Number(totalCost.toFixed(4)) };
}
