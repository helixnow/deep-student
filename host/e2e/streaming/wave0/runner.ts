/**
 * WAVE0 stream scenario runner (X5). Executes one §3 v0 scenario through a backend
 * driver and returns a StreamRecord from the production recorder.
 *
 * The driver is the only side-specific part: B uses the in-process test host
 * (`hostDriver`); A (X7 Tauri harness) implements the same three methods over
 * `__TAURI_INTERNALS__.invoke` and its window event tap.
 *
 * Scenario extensions to v0 (proposed to X7, see audits/X5-stream-parity.md §WAVE0):
 * - `llm: "<scriptId>"` selects a deterministic LLM script; `${llm.baseUrl}` (L14: `${provider.url}`) expands to its ApiConfig baseUrl.
 * - step `waitBefore` / `waitAfter`: `{ "event": "<eventType>" | "<type>:<phase>", "channelPrefix"?: string }`.
 *   Waits poll the recorded events with a fixed deadline and fail loudly; they never skip a step.
 */
import type { BackendEvent } from '../../../kernel/protocol.ts';
import type { LlmService } from './llm-service.ts';
import { StreamRecorder, type StreamRecord } from './recorder.ts';
import { exactObjectJson, nativeJson, parseWireJson } from './wire-json.ts';
import { HandlerPanic, type HostRuntime } from '../../../kernel/testing.ts';

export interface WaitSpec { event: string; channelPrefix?: string }
export interface ScenarioStep { cmd: string; args?: unknown; expect?: 'error'; waitBefore?: WaitSpec; waitAfter?: WaitSpec }
export interface Scenario {
  id: string;
  seed: string;
  llm?: string;
  steps: ScenarioStep[];
  capture?: { events?: boolean; db?: string[] };
  normalize?: string[];
}
export interface ScenarioFile { domain: string; commands: string[]; scenarios: Scenario[] }

export interface StreamDriver {
  invoke(cmd: string, args: unknown): Promise<unknown>;
  /** Source-preserving invoke result/error. A drivers must tap the original response text. */
  invokeWire?(cmd: string, args: unknown): Promise<{ ok: boolean; value: unknown; json: string | null }>;
  /** Append every event emitted since the last call, in order. */
  drainEvents(recorder: StreamRecorder): void;
  /** Wait for the backend's own background work to finish (not a sleep), then drain once more. */
  settle(recorder: StreamRecorder): Promise<void>;
}

/** Fixed deadline per wait; same 15s budget the existing X5 tests use for pipeline drain. */
export const WAIT_DEADLINE_MS = 15_000;

function lookup(path: string, results: unknown[], llm: { baseUrl: string } | null): unknown {
  const [head, ...rest] = path.split('.');
  let value: unknown;
  if (head === 'llm' || head === 'provider') {
    if (!llm) throw new Error(`scenario references \${${path}} but declares no llm script`);
    value = head === 'provider' ? { url: llm.baseUrl } : llm;
  } else {
    const index = Number(head);
    if (!Number.isInteger(index) || index < 0 || index >= results.length) throw new Error(`\${${path}}: step ${head} has no result yet`);
    value = results[index];
  }
  for (const key of rest) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new Error(`\${${path}}: missing key ${key}`);
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export function resolvePlaceholders(value: unknown, results: unknown[], llm: { baseUrl: string } | null): unknown {
  if (nativeJson.isRawJSON(value)) return value;
  if (typeof value === 'string') {
    const whole = /^\$\{([^}]+)\}$/.exec(value);
    if (whole) return lookup(whole[1]!, results, llm);
    return value.replace(/\$\{([^}]+)\}/g, (_m, path: string) => {
      const found = lookup(path, results, llm);
      return nativeJson.isRawJSON(found) ? found.rawJSON : String(found);
    });
  }
  if (Array.isArray(value)) return value.map(item => resolvePlaceholders(item, results, llm));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolvePlaceholders(item, results, llm)]));
  }
  return value;
}

function matches(spec: WaitSpec, channel: string, payload: unknown): boolean {
  if (spec.channelPrefix !== undefined && !channel.startsWith(spec.channelPrefix)) return false;
  const p = payload as { eventType?: unknown; type?: unknown; phase?: unknown } | null;
  return p?.eventType === spec.event || `${String(p?.type)}:${String(p?.phase)}` === spec.event;
}

async function waitFor(spec: WaitSpec, driver: StreamDriver, recorder: StreamRecorder, results: unknown[], llm: { baseUrl: string } | null) {
  const resolved = resolvePlaceholders(spec, results, llm) as WaitSpec;
  const deadline = Date.now() + WAIT_DEADLINE_MS;
  for (;;) {
    driver.drainEvents(recorder);
    if (recorder.events.some(event => matches(resolved, event.channel, event.payload))) return;
    if (Date.now() > deadline) throw new Error(`wait for ${JSON.stringify(resolved)} exceeded ${WAIT_DEADLINE_MS}ms; ${recorder.events.length} events recorded`);
    await new Promise(resolve => setImmediate(resolve));
  }
}

export async function runScenario(scenario: Scenario, driver: StreamDriver, options: {
  side: 'A' | 'B'; take: string; llm: LlmService | null;
}): Promise<StreamRecord> {
  if (scenario.llm && !options.llm) throw new Error(`scenario ${scenario.id} needs an llm service`);
  const llm = scenario.llm && options.llm ? { baseUrl: options.llm.baseUrl(scenario.llm) } : null;
  const recorder = new StreamRecorder({ scenario: scenario.id, side: options.side, take: options.take, llmScript: scenario.llm ?? null });
  const results: unknown[] = [];
  for (const step of scenario.steps) {
    if (step.waitBefore) await waitFor(step.waitBefore, driver, recorder, results, llm);
    const args = resolvePlaceholders(step.args === undefined ? {} : step.args, results, llm);
    driver.drainEvents(recorder);
    const eventsBefore = recorder.events.length;
    let ok = true;
    let value: unknown;
    let valueJson: string | null = null;
    const argsJson = exactObjectJson(args);
    try {
      if (driver.invokeWire) {
        const result = await driver.invokeWire(step.cmd, args);
        ok = result.ok; value = result.value; valueJson = result.json;
      } else value = await driver.invoke(step.cmd, args);
    } catch (error) { ok = false; value = errorValue(error); }
    driver.drainEvents(recorder);
    recorder.step({ cmd: step.cmd, args, argsJson, ok, value, valueJson, eventsBefore, eventsAfter: recorder.events.length });
    results.push(ok ? (valueJson === null ? value : parseWireJson(valueJson)) : null);
    if (step.waitAfter) await waitFor(step.waitAfter, driver, recorder, results, llm);
  }
  await driver.settle(recorder);
  // Provider connections must close on their own after the backend settled (EOF, [DONE] or the
  // backend's cancel). An open stream here stays visible as `llmIdle: false` and `end: null`.
  const llmIdle = options.llm ? await options.llm.whenIdle(WAIT_DEADLINE_MS) : true;
  return { ...recorder.finish(options.llm?.requests ?? []), llmOrigin: options.llm?.url ?? null, llmIdle };
}

/** Frontend-visible error value: test host rejects with the wire error itself; only a panic is an Error. */
function errorValue(error: unknown): unknown {
  if (error instanceof Error) return { thrown: error.name, message: error.message };
  return error;
}

/** B side over the in-process test host (real plugins). */
export function hostDriver(host: {
  invoke(cmd: string, args: unknown): Promise<unknown>;
  runtime: Pick<HostRuntime, 'dispatchInvoke'>;
  readonly events: readonly BackendEvent[];
  ctx: { chatState: { shutdownTasks(timeoutMs: number): Promise<boolean> } };
}): StreamDriver {
  let cursor = host.events.length;
  let invokeIndex = 0;
  return {
    invoke: (cmd, args) => host.invoke(cmd, args),
    async invokeWire(cmd, args) {
      // Same production dispatch as testHost.invoke, retaining its source text before projection.
      // Keep the original input object/atoms; do not round-trip args through JSON.parse.
      const outcome = await host.runtime.dispatchInvoke({ id: `x5-wave0-${++invokeIndex}`, cmd,
        args, source: { window: 'main', webview: 'main' } });
      if (outcome.kind === 'panic') throw new HandlerPanic(cmd, outcome.error, outcome.reply);
      const value = outcome.kind === 'ok' ? outcome.value : outcome.error;
      return { ok: outcome.kind === 'ok', value, json: outcome.json ?? exactObjectJson(value) };
    },
    drainEvents(recorder) { cursor = recorder.pullHostEvents(host.events, cursor); },
    async settle(recorder) {
      // Real tracked pipeline drain (chat state owner), not a sleep. A false result is a finding.
      if (!await host.ctx.chatState.shutdownTasks(WAIT_DEADLINE_MS)) throw new Error('B settle: chat tasks did not drain');
      cursor = recorder.pullHostEvents(host.events, cursor);
    },
  };
}
