import type { KillSwitchStatus } from '../api.ts';
import type { ChatLogger } from './logger.ts';

export const KILL_SWITCH_BLOCKED_MESSAGE = 'AgentKillSwitch tripped: all agent activity is stopped. Call chat_v2_resume_agents to resume.';
export const KILL_SWITCH_STATE_UNAVAILABLE_MESSAGE = 'AgentKillSwitch gate: ChatV2State is unavailable, admission denied (fail-closed).';
export const KILL_SWITCH_CHANGED_EVENT = 'chat_v2://kill_switch_changed';

export class AgentKillSwitch {
  private _tripped = false;
  private _trippedAtMs: number | null = null;
  private _reason: string | null = null;
  isTripped(): boolean { return this._tripped; }
  trip(reason: string): boolean {
    const wasClear = !this._tripped;
    this._tripped = true;
    if (this._trippedAtMs === null || wasClear) this._trippedAtMs = Math.max(0, Date.now());
    if (wasClear || this._reason === null) this._reason = reason;
    return wasClear;
  }
  reset(): void { this._tripped = false; this._trippedAtMs = null; this._reason = null; }
  ensureAllowed(): void {
    if (this._tripped) throw new Error(KILL_SWITCH_BLOCKED_MESSAGE);
  }
  /** L06 supplies its scheduler state; reset never changes that independent state. */
  statusSnapshot(automationsPaused: boolean): KillSwitchStatus {
    return { tripped: this._tripped, killSwitchTripped: this._tripped,
      trippedAtMs: this._trippedAtMs, reason: this._reason, automationsPaused };
  }
}

export interface StreamRegistration { readonly token: AbortController; readonly generation: bigint; }

/** Rust state.rs: each mutation runs synchronously, matching the Mutex critical section. */
export class ChatV2State {
  readonly killSwitch = new AgentKillSwitch();
  private _active = new Map<string, StreamRegistration>();
  private _nextGeneration = 1n;
  private _tasks = new Set<Promise<unknown>>();
  private _closed = false;
  private _drainListeners = new Set<() => void>();

  private readonly log: ChatLogger | null;

  constructor(log: ChatLogger | null = null) {
    this.log = log;
  }

  private allocateGeneration(): bigint {
    const current = this._nextGeneration;
    this._nextGeneration = BigInt.asUintN(64, current + 1n);
    return current;
  }
  spawnTracked<T>(future: Promise<T>): Promise<T> {
    const tracked = future.finally(() => {
      this._tasks.delete(tracked);
      this.notifyDrained();
    });
    this._tasks.add(tracked);
    return tracked;
  }
  trackedTaskCount(): number { return this._tasks.size; }
  closeTaskTracker(): void { this._closed = true; this.notifyDrained(); }
  private notifyDrained(): void {
    if (this._closed && this._tasks.size === 0) for (const listener of [...this._drainListeners]) listener();
  }
  async shutdownTasks(timeoutMs: number): Promise<boolean> {
    this.closeTaskTracker();
    if (this._tasks.size === 0) return true;
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); this._drainListeners.delete(finish); resolve(true); };
      const timer = setTimeout(() => { this._drainListeners.delete(finish); resolve(false); }, timeoutMs);
      this._drainListeners.add(finish);
    });
  }
  registerStream(id: string): AbortController {
    const token = new AbortController();
    if (this.killSwitch.isTripped()) { token.abort(); return token; }
    if (this._active.has(id)) this.log?.warn('[ChatV2::state] registerStream overwrote existing registration: ' + id);
    this._active.set(id, { token, generation: this.allocateGeneration() });
    return token;
  }
  tryRegisterStream(id: string): AbortController | null { return this.tryRegisterStreamOwned(id)?.token ?? null; }
  tryRegisterStreamOwned(id: string): StreamRegistration | null {
    if (this.killSwitch.isTripped() || this._active.has(id)) return null;
    const registration = { token: new AbortController(), generation: this.allocateGeneration() };
    this._active.set(id, registration);
    return registration;
  }
  registerExistingToken(id: string, token: AbortController): void { this.registerExistingTokenOwned(id, token); }
  registerExistingTokenOwned(id: string, token: AbortController): StreamRegistration {
    if (this.killSwitch.isTripped()) { token.abort(); return { token, generation: 0n }; }
    const registration = { token, generation: this.allocateGeneration() };
    this._active.set(id, registration);
    return registration;
  }
  cancelStream(id: string): boolean {
    const active = this._active.get(id);
    if (!active) return false;
    this._active.delete(id);
    active.token.abort();
    return true;
  }
  cancelAllStreams(): number {
    const active = [...this._active.values()];
    this._active.clear();
    for (const stream of active) stream.token.abort();
    return active.length;
  }
  removeStream(id: string): void { this._active.delete(id); }
  removeStreamIfGeneration(id: string, generation: bigint): boolean {
    if (this._active.get(id)?.generation !== generation) return false;
    return this._active.delete(id);
  }
  hasActiveStream(id: string): boolean { return this._active.has(id); }
  activeStreamCount(): number { return this._active.size; }
  registrationGeneration(id: string): bigint | null { return this._active.get(id)?.generation ?? null; }
}

/** Use in finally, or with Symbol.dispose, to reproduce Rust Drop during unwinding. */
export class StreamGuard {
  readonly generation: bigint;
  private readonly _state: ChatV2State;
  private readonly _sessionId: string;
  constructor(state: ChatV2State, sessionId: string, registration: StreamRegistration) {
    this._state = state; this._sessionId = sessionId; this.generation = registration.generation;
  }
  static fromRegisteredToken(state: ChatV2State, sessionId: string, token: AbortController): StreamGuard | null {
    if (token.signal.aborted) return null;
    const generation = state.registrationGeneration(sessionId);
    if (generation === null || token.signal.aborted) return null;
    return new StreamGuard(state, sessionId, { token, generation });
  }
  dispose(): void { this._state.removeStreamIfGeneration(this._sessionId, this.generation); }
  [Symbol.dispose](): void { this.dispose(); }
}
