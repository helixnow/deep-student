/** automations.rs:3563–3698: in-process single-flight and live-executor registry. */

const runningAutomations = new Set<string>();

export class AgentAutomationRunGuard {
  private readonly automationId: string;
  private constructor(automationId: string) { this.automationId = automationId; }

  static tryAcquire(automationId: string): AgentAutomationRunGuard | null {
    if (runningAutomations.has(automationId)) return null;
    runningAutomations.add(automationId);
    return new AgentAutomationRunGuard(automationId);
  }

  release(): void {
    runningAutomations.delete(this.automationId);
  }
}

interface ActiveEntry { generation: number; token: AbortController }
const activeRuns = new Map<string, ActiveEntry>();
let nextGeneration = 1;

export class ActiveAutomationRunGuard {
  private readonly runId: string;
  private readonly generation: number;
  private constructor(runId: string, generation: number) {
    this.runId = runId;
    this.generation = generation;
  }

  static register(runId: string): { guard: ActiveAutomationRunGuard; token: AbortController } {
    const token = new AbortController();
    const generation = nextGeneration;
    nextGeneration += 1;
    activeRuns.set(runId, { generation, token });
    return { guard: new ActiveAutomationRunGuard(runId, generation), token };
  }

  release(): void {
    const current = activeRuns.get(this.runId);
    if (current !== undefined && current.generation === this.generation) activeRuns.delete(this.runId);
  }
}

export function automationRunHasLiveExecutor(runId: string): boolean {
  return activeRuns.has(runId);
}

/** Returns true when a live token existed and was aborted. */
export function cancelAutomationRunToken(runId: string): boolean {
  const entry = activeRuns.get(runId);
  if (entry === undefined || entry.token.signal.aborted) return false;
  entry.token.abort();
  return true;
}

/** automations.rs:3641–3665: cancel every in-flight token (Kill Switch / shutdown). */
export function cancelAllAutomationRunTokens(): number {
  let cancelled = 0;
  for (const entry of activeRuns.values()) {
    if (entry.token.signal.aborted) continue;
    entry.token.abort();
    cancelled += 1;
  }
  return cancelled;
}
