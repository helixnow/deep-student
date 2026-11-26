// Nested-activity quiescence state machine for external coding CLI turns.
// Prevents premature completion/parking while internal child subagents or background
// tasks remain active after the main turn stream settles.

import type { ActiveChildSubagentSummary, NormalizedRuntimeEvent } from './adapter-types.ts';

export type QuiescencePhase =
  | 'idle'
  | 'running'
  | 'waiting_children'
  | 'quiescent'
  | 'interrupted'
  | 'failed';

export interface ChildSubagentRecord {
  readonly id: string;
  readonly title: string;
  readonly parentToolUseId: string | null;
  readonly startedAt: number;
}

export interface QuiescenceTrackerOptions {
  readonly threadId: string;
  readonly onEvent?: (event: NormalizedRuntimeEvent) => void;
  /**
   * Safety idle fallback timeout (in milliseconds) once in `'waiting_children'`.
   * If all child notifications stop arriving and a child crashes silently without
   * emitting a completion frame, emits `'quiescent_completed'` with `timedOut: true`.
   * Pass `0` or a negative value to disable the fallback timer.
   */
  readonly safetyIdleTimeoutMs?: number;
  readonly now?: () => number;
}

const DEFAULT_SAFETY_IDLE_TIMEOUT_MS = 120_000;

export class QuiescenceTracker {
  readonly threadId: string;
  turnActive = false;
  readonly activeChildSubagents = new Map<string, ChildSubagentRecord>();
  readonly activeBgTasks = new Set<string>();

  private readonly completedChildIds = new Set<string>();
  private readonly onEvent?: (event: NormalizedRuntimeEvent) => void;
  private readonly safetyIdleTimeoutMs: number;
  private readonly now: () => number;
  private currentPhase: QuiescencePhase = 'idle';
  private externalSessionId: string | undefined;
  private safetyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: QuiescenceTrackerOptions) {
    this.threadId = options.threadId;
    this.onEvent = options.onEvent;
    this.safetyIdleTimeoutMs = options.safetyIdleTimeoutMs ?? DEFAULT_SAFETY_IDLE_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  get phase(): QuiescencePhase {
    return this.currentPhase;
  }

  hasPendingChildren(): boolean {
    return this.activeChildSubagents.size > 0 || this.activeBgTasks.size > 0;
  }

  isCompletedChild(childId: string): boolean {
    return this.completedChildIds.has(childId);
  }

  setExternalSessionId(externalSessionId: string): void {
    this.externalSessionId = externalSessionId;
  }

  markTurnStarted(): void {
    this.clearSafetyTimer();
    this.turnActive = true;
    this.currentPhase = 'running';
  }

  startSubagent(input: {
    id: string;
    title: string;
    parentToolUseId?: string | null;
    agentType?: string;
    emitEvent?: boolean;
  }): boolean {
    if (!input.id || this.isTerminal()) return false;
    const alreadyTracked = this.activeChildSubagents.has(input.id);
    const ts = this.now();
    const record: ChildSubagentRecord = {
      id: input.id,
      title: input.title || input.id,
      parentToolUseId: input.parentToolUseId ?? null,
      startedAt: alreadyTracked
        ? (this.activeChildSubagents.get(input.id)?.startedAt ?? ts)
        : ts,
    };
    this.activeChildSubagents.set(input.id, record);
    this.completedChildIds.delete(input.id);

    if (this.currentPhase === 'waiting_children') {
      this.armSafetyTimer();
    }

    if (!alreadyTracked && input.emitEvent !== false) {
      this.emit({
        type: 'subagent_started',
        threadId: this.threadId,
        parentToolUseId: record.parentToolUseId,
        childId: record.id,
        title: record.title,
        agentType: input.agentType,
        timestamp: ts,
      });
    }
    return !alreadyTracked;
  }

  completeSubagent(input: {
    id: string;
    status?: 'completed' | 'failed' | 'stopped';
    summary?: string;
    emitEvent?: boolean;
  }): boolean {
    const existing = this.activeChildSubagents.get(input.id);
    if (!existing) return false;

    this.activeChildSubagents.delete(input.id);
    this.completedChildIds.add(input.id);
    const ts = this.now();

    if (input.emitEvent !== false) {
      this.emit({
        type: 'subagent_completed',
        threadId: this.threadId,
        childId: input.id,
        parentToolUseId: existing.parentToolUseId,
        status: input.status ?? 'completed',
        summary: input.summary,
        timestamp: ts,
      });
    }

    this.evaluatePostChildSettlement();
    return true;
  }

  startBgTask(input: {
    taskId: string;
    title?: string;
    command?: string;
    pid?: number;
    emitEvent?: boolean;
  }): boolean {
    if (!input.taskId || this.isTerminal()) return false;
    const alreadyTracked = this.activeBgTasks.has(input.taskId);
    this.activeBgTasks.add(input.taskId);

    if (this.currentPhase === 'waiting_children') {
      this.armSafetyTimer();
    }

    if (!alreadyTracked && input.emitEvent !== false) {
      this.emit({
        type: 'bg_task_started',
        threadId: this.threadId,
        taskId: input.taskId,
        title: input.title,
        command: input.command,
        pid: input.pid,
        timestamp: this.now(),
      });
    }
    return !alreadyTracked;
  }

  completeBgTask(input: {
    taskId: string;
    exitCode?: number | null;
    summary?: string;
    emitEvent?: boolean;
  }): boolean {
    if (!this.activeBgTasks.has(input.taskId)) return false;
    this.activeBgTasks.delete(input.taskId);

    if (input.emitEvent !== false) {
      this.emit({
        type: 'bg_task_completed',
        threadId: this.threadId,
        taskId: input.taskId,
        exitCode: input.exitCode,
        summary: input.summary,
        timestamp: this.now(),
      });
    }

    this.evaluatePostChildSettlement();
    return true;
  }

  touchChildActivity(): void {
    if (this.currentPhase === 'waiting_children') {
      this.armSafetyTimer();
    }
  }

  settleMainTurn(meta?: { externalSessionId?: string; stopReason?: string }): QuiescencePhase {
    if (this.isTerminal() || this.currentPhase === 'quiescent') {
      return this.currentPhase;
    }
    if (meta?.externalSessionId) {
      this.externalSessionId = meta.externalSessionId;
    }

    this.turnActive = false;
    const waitingForChildren = this.hasPendingChildren();
    const ts = this.now();

    this.emit({
      type: 'turn_settled',
      threadId: this.threadId,
      externalSessionId: this.externalSessionId,
      stopReason: meta?.stopReason,
      waitingForChildren,
      timestamp: ts,
    });

    if (waitingForChildren) {
      this.currentPhase = 'waiting_children';
      this.emit({
        type: 'waiting_children',
        threadId: this.threadId,
        activeSubagents: this.snapshotActiveSubagents(),
        activeBgTasks: [...this.activeBgTasks],
        timestamp: ts,
      });
      this.armSafetyTimer();
      return this.currentPhase;
    }

    this.finalizeQuiescent(false);
    return this.currentPhase;
  }

  markInterrupted(reason?: string): void {
    if (this.isTerminal()) return;
    this.clearSafetyTimer();
    this.turnActive = false;
    this.activeChildSubagents.clear();
    this.activeBgTasks.clear();
    this.currentPhase = 'interrupted';
    this.emit({
      type: 'turn_interrupted',
      threadId: this.threadId,
      reason,
      timestamp: this.now(),
    });
  }

  markFailed(message: string, code?: string, recoverable = true): void {
    if (this.isTerminal()) return;
    this.clearSafetyTimer();
    this.turnActive = false;
    this.activeChildSubagents.clear();
    this.activeBgTasks.clear();
    this.currentPhase = 'failed';
    this.emit({
      type: 'turn_error',
      threadId: this.threadId,
      message,
      code,
      recoverable,
      timestamp: this.now(),
    });
  }

  snapshotActiveSubagents(): ActiveChildSubagentSummary[] {
    return [...this.activeChildSubagents.values()].map((entry) => ({
      id: entry.id,
      title: entry.title,
      parentToolUseId: entry.parentToolUseId,
      startedAt: entry.startedAt,
    }));
  }

  dispose(): void {
    this.clearSafetyTimer();
    this.turnActive = false;
    this.activeChildSubagents.clear();
    this.activeBgTasks.clear();
  }

  private evaluatePostChildSettlement(): void {
    if (this.currentPhase !== 'waiting_children') return;
    if (!this.turnActive && !this.hasPendingChildren()) {
      this.finalizeQuiescent(false);
      return;
    }
    this.armSafetyTimer();
  }

  private finalizeQuiescent(timedOut: boolean): void {
    if (this.currentPhase === 'quiescent' || this.isTerminal()) return;
    this.clearSafetyTimer();
    this.turnActive = false;
    if (timedOut) {
      this.activeChildSubagents.clear();
      this.activeBgTasks.clear();
    }
    this.currentPhase = 'quiescent';
    this.emit({
      type: 'quiescent_completed',
      threadId: this.threadId,
      externalSessionId: this.externalSessionId,
      timedOut,
      timestamp: this.now(),
    });
  }

  private armSafetyTimer(): void {
    this.clearSafetyTimer();
    if (this.safetyIdleTimeoutMs <= 0) return;
    this.safetyTimer = setTimeout(() => {
      this.safetyTimer = null;
      if (this.currentPhase === 'waiting_children' && !this.turnActive) {
        this.finalizeQuiescent(true);
      }
    }, this.safetyIdleTimeoutMs);
    this.safetyTimer.unref?.();
  }

  private clearSafetyTimer(): void {
    if (this.safetyTimer !== null) {
      clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }
  }

  private isTerminal(): boolean {
    return this.currentPhase === 'interrupted' || this.currentPhase === 'failed';
  }

  private emit(event: NormalizedRuntimeEvent): void {
    this.onEvent?.(event);
  }
}
