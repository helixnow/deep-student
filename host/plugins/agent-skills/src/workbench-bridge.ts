import { randomUUID } from 'node:crypto';
import type { AcrBridgeResponse } from '../api.ts';

export const APPLY_OPS_BASE_MS = 30_000;
export const APPLY_OPS_CLAMP_MS = 120_000;
export const PROBE_TIMEOUT_MS = 3_000;
export const clampBridgeTimeout = (ms: number): number => Math.min(300_000, Math.max(1_000, ms));

export function pacingPerOpMs(pacing: string): number {
  switch (pacing.trim().replace(/[A-Z]/g, c => c.toLowerCase())) {
    case 'fast': return 50;
    case 'demo': return 600;
    default: return 300;
  }
}

export function applyOpsTimeoutMs(opsLen: number, pacing?: string | null): number {
  return Math.min(APPLY_OPS_CLAMP_MS, Math.max(1000, APPLY_OPS_BASE_MS + opsLen * pacingPerOpMs(pacing ?? 'normal')));
}

export function uncertainApplyReceipt(entityIds: string[], opLabels: string[], error: string) {
  return {
    status: 'partial', mode: 'frontend', applied: null, totalOps: opLabels.length,
    entityIds, done: [], undone: [], unknownOps: opLabels, code: 'RESULT_UNKNOWN',
    message: '前端委托已提交，但桥响应失败；已请求停止。结果可能已部分应用，请先重新读取目标，勿回落后端或原样重试。',
    error, resultUnknown: true, retryable: false,
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const u64 = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 18446744073709551615;
const stringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(v => typeof v === 'string');
const nonEmptyString = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0;

export function isValidApplyReceipt(value: unknown): boolean {
  if (!object(value)) return false;
  const { status, mode, applied, totalOps, entityIds, done, undone } = value;
  if (typeof status !== 'string' || !['completed', 'partial', 'cancelled', 'failed'].includes(status)) return false;
  if (typeof mode !== 'string' || !['frontend', 'backend', 'suggestion'].includes(mode)) return false;
  if (!u64(applied) || !u64(totalOps) || applied > totalOps) return false;
  if (!stringArray(entityIds) || !stringArray(done) || !stringArray(undone)) return false;
  if (mode === 'suggestion') {
    if (status === 'failed') return applied === 0 && done.length === 0 && undone.length <= totalOps && value.suggestionPending !== true;
    if (value.suggestionPending !== true) return false;
    return (done.length === applied && applied + undone.length === totalOps)
      || (done.length === applied + 1 && applied + undone.length + 1 === totalOps);
  }
  if (status === 'completed') return applied === totalOps && undone.length === 0 && done.length === applied;
  if (status === 'partial' || status === 'cancelled') return done.length === applied && applied + undone.length === totalOps;
  return applied === 0 && done.length === 0 && undone.length <= totalOps;
}

export function sessionScopedRunId(sessionId: string, toolCallId: string): string {
  return `acr3:${Buffer.byteLength(sessionId)}:${sessionId}:${toolCallId}`;
}

export class CancelOnDrop {
  _action: (() => void) | undefined;
  constructor(action: () => void) { this._action = action; }
  disarm(): void { this._action = undefined; }
  dispose(): void {
    const action = this._action;
    this._action = undefined;
    action?.();
  }
}

export function isBridgeCancelled(error: string): boolean {
  const lower = error.replace(/[A-Z]/g, c => c.toLowerCase());
  return lower.startsWith('cancelled') || lower.includes('cancelled:') || lower.includes('"code":"cancelled"');
}
export function isBridgeResultUnknown(error: string): boolean { return error.trimStart().startsWith('RESULT_UNKNOWN:'); }

export function isValidCommandData(command: string, data: unknown): boolean {
  if (!object(data)) return false;
  switch (command) {
    case 'apply_ops': return isValidApplyReceipt(data);
    case 'probe': return typeof data.state === 'string' && ['closed', 'clean', 'dirty', 'hot', 'frozen', 'disabled'].includes(data.state)
      && (data.windowId === null || typeof data.windowId === 'string');
    case 'act': return typeof data.status === 'string' && ['completed', 'partial', 'failed'].includes(data.status)
      && ['windowId', 'typeId', 'beforeRevision', 'afterRevision'].every(key => nonEmptyString(data[key]))
      && Array.isArray(data.results) && typeof data.verified === 'boolean' && Array.isArray(data.failedConditions)
      && object(data.observation) && (data.status !== 'completed' || data.verified === true);
    case 'wait_for': return typeof data.matched === 'boolean' && typeof data.timedOut === 'boolean' && data.matched !== data.timedOut
      && u64(data.elapsedMs) && Array.isArray(data.failedConditions) && object(data.observation);
    case 'revert_run': return typeof data.reverted === 'boolean';
    case 'list_windows': return Array.isArray(data.windows);
    case 'open_app': return nonEmptyString(data.windowId) && typeof data.created === 'boolean';
    case 'app_command': return data.handled === true ? data.acknowledged === true : data.handled === false && nonEmptyString(data.code);
    case 'close_window': return typeof data.closed === 'boolean';
    case 'get_capabilities': return Array.isArray(data.apps);
    case 'observe': return ['revision', 'windowId', 'typeId'].every(key => nonEmptyString(data[key]));
    case 'query_state': return true;
    default: return false;
  }
}

function unexpected(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return `string ${JSON.stringify(value)}`;
  if (typeof value === 'boolean') return `boolean \`${value}\``;
  if (typeof value === 'number') return `${Number.isInteger(value) ? 'integer' : 'floating point'} \`${value}\``;
  return Array.isArray(value) ? 'sequence' : 'map';
}

// serde_json::from_value reports malformed fields in map iteration order, then missing fields.
export function parseBridgeResponse(value: unknown, correlationId: string, token: string, command: string): AcrBridgeResponse {
  const malformed = (message: string): never => { throw new Error(`ACR bridge protocol error: malformed response: ${message}`); };
  if (!object(value)) return malformed(`invalid type: ${unexpected(value)}, expected struct AcrBridgeResponse`);
  for (const [key, field] of Object.entries(value)) {
    if (key === 'correlationId' || key === 'bridgeToken' || (key === 'error' && field != null)) {
      if (typeof field !== 'string') malformed(`invalid type: ${unexpected(field)}, expected a string`);
    } else if (key === 'ok' && typeof field !== 'boolean') malformed(`invalid type: ${unexpected(field)}, expected a boolean`);
  }
  for (const key of ['correlationId', 'bridgeToken', 'ok']) if (!Object.hasOwn(value, key)) malformed(`missing field \`${key}\``);
  const response: AcrBridgeResponse = {
    correlationId: value.correlationId as string, bridgeToken: value.bridgeToken as string, ok: value.ok as boolean,
    ...(value.data == null ? {} : { data: value.data }), ...(value.error == null ? {} : { error: value.error as string }),
  };
  if (response.correlationId !== correlationId || response.bridgeToken !== token) throw new Error('ACR bridge protocol error: response identity mismatch');
  if (response.ok) {
    if (response.data == null) throw new Error('ACR bridge protocol error: ok=true requires non-null data');
    if (response.error !== undefined) throw new Error('ACR bridge protocol error: ok=true forbids error');
    if (!isValidCommandData(command, response.data)) throw new Error(`ACR bridge protocol error: malformed ${command} receipt`);
  } else {
    if (response.data !== undefined) throw new Error('ACR bridge protocol error: ok=false forbids data');
    if (!response.error?.trim()) throw new Error('ACR bridge protocol error: ok=false requires non-empty error');
  }
  return response;
}

export function parseTerminalResponse(value: unknown, correlationId: string, token: string, command: string): AcrBridgeResponse {
  try { return parseBridgeResponse(value, correlationId, token, command); }
  catch (error) {
    if (['apply_ops', 'act', 'revert_run', 'open_app', 'app_command', 'close_window'].includes(command)) {
      throw new Error(`RESULT_UNKNOWN: ${error instanceof Error ? error.message : String(error)}`);
    }
    throw error;
  }
}

// ------------------------------------------------------------------ bridge transport

/** Tauri-window analogue: `emit` plus `listen` returning an unlisten function. */
export interface BridgeEventBus {
  emit(event: string, payload: unknown): void;
  listen(event: string, handler: (payload: unknown) => void): () => void;
}

export interface AcrBridgeLogger {
  debug?(message: string): void;
  info?(message: string): void;
  warn?(message: string): void;
}

/** Per-call host state (`workbench_bridge.rs::acr_bridge_call` context). */
export interface AcrBridgeCallContext {
  /** Non-empty session id; used verbatim in the session-scoped run id. */
  sessionId: string;
  /** Original LLM tool-call id; non-empty. */
  toolCallId: string;
  events: BridgeEventBus;
  /** Rust `ctx.cancellation_token()`; `null` means no cancellation token. */
  cancel?: AbortSignal | null;
  /** Progress chunks are forwarded here (`emit_chunk(TOOL_CALL, block_id, ..)`). */
  emitProgressChunk?: (chunk: string) => void;
  logger?: AcrBridgeLogger;
  /** Optional channel-closed signal (Rust oneshot sender dropped). */
  channelClosed?: Promise<unknown>;
  /** Test seam; defaults to `crypto.randomUUID`. */
  uuid?: () => string;
  /** Bounded terminal-receipt drain window; Rust `CANCEL_DRAIN_MS`. */
  drainMs?: number;
}

export const ACR_BRIDGE_REQUEST = 'acr:bridge-request';
export const ACR_BRIDGE_RESPONSE_PREFIX = 'acr:bridge-response:';
export const ACR_BRIDGE_PROGRESS_PREFIX = 'acr:bridge-progress:';
export const ACR_BRIDGE_CANCEL = 'acr:bridge-cancel';
export const CANCEL_DRAIN_MS = 3_000;

interface AcrBridgeCancel {
  correlationId: string;
  bridgeToken: string;
  runId: string;
  toolCallId: string;
  sessionId: string;
}

function decodeEventPayload(payload: unknown): unknown {
  if (typeof payload !== 'string') return payload;
  try { return JSON.parse(payload); } catch { return undefined; }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emitBridgeCancel(
  ctx: AcrBridgeCallContext,
  payload: AcrBridgeCancel,
  reason: string,
): void {
  try {
    ctx.events.emit(ACR_BRIDGE_CANCEL, payload);
  } catch (error) {
    ctx.logger?.warn?.(`[workbench_bridge] emit ${ACR_BRIDGE_CANCEL} failed after ${reason}: ${errorText(error)}`);
  }
}

type WaitOutcome =
  | { kind: 'response'; value: unknown }
  | { kind: 'timed_out' }
  | { kind: 'cancelled' }
  | { kind: 'channel_closed' };

async function waitOutcome(
  response: Promise<unknown>,
  timeoutMs: number,
  cancel: AbortSignal | null,
  channelClosed: Promise<unknown> | undefined,
): Promise<WaitOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const waiters: Array<Promise<WaitOutcome>> = [
    response.then(value => ({ kind: 'response', value })),
    new Promise<WaitOutcome>(resolve => {
      timer = setTimeout(() => resolve({ kind: 'timed_out' }), timeoutMs);
    }),
  ];
  if (cancel !== null) {
    waiters.push(new Promise<WaitOutcome>(resolve => {
      if (cancel.aborted) {
        resolve({ kind: 'cancelled' });
        return;
      }
      abortHandler = () => resolve({ kind: 'cancelled' });
      cancel.addEventListener('abort', abortHandler, { once: true });
    }));
  }
  if (channelClosed !== undefined) {
    waiters.push(channelClosed.then(() => ({ kind: 'channel_closed' })));
  }
  try {
    return await Promise.race(waiters);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (cancel !== null && abortHandler !== undefined) cancel.removeEventListener('abort', abortHandler);
  }
}

/**
 * Port of `workbench_bridge.rs::acr_bridge_call`.
 *
 * - listens for response/progress before emitting the request;
 * - races response / timeout / cancellation / channel close;
 * - cancels the front end and drains a bounded terminal receipt on timeout,
 *   cancellation or channel close;
 * - holds `CancelOnDrop` until a terminal response or explicit cancel path so
 *   an aborted caller still stops the front-end StageManager.
 */
export async function acrBridgeCall(
  ctx: AcrBridgeCallContext,
  command: string,
  args: unknown,
  timeoutMs: number,
): Promise<AcrBridgeResponse> {
  const clamped = clampBridgeTimeout(timeoutMs);
  if (ctx.sessionId.trim() === '' || ctx.toolCallId.trim() === '') {
    throw new Error('ACR bridge protocol error: non-empty sessionId and toolCallId are required');
  }
  const correlationId = ctx.uuid ? ctx.uuid() : randomUUID();
  const bridgeToken = ctx.uuid ? ctx.uuid() : randomUUID();
  const responseEvent = `${ACR_BRIDGE_RESPONSE_PREFIX}${correlationId}`;
  const progressEvent = `${ACR_BRIDGE_PROGRESS_PREFIX}${correlationId}`;

  const toolCallId = ctx.toolCallId;
  const sessionId = ctx.sessionId;
  const runId = sessionScopedRunId(sessionId, toolCallId);
  const cancelPayload: AcrBridgeCancel = {
    correlationId, bridgeToken, runId, toolCallId, sessionId,
  };

  let resolveResponse!: (value: unknown) => void;
  const response = new Promise<unknown>(resolve => { resolveResponse = resolve; });
  let responseDelivered = false;

  const unlistenResponse = ctx.events.listen(responseEvent, payload => {
    const value = decodeEventPayload(payload);
    if (value === undefined) return;
    const matches = object(value)
      && value.correlationId === correlationId
      && value.bridgeToken === bridgeToken;
    if (!matches) {
      ctx.logger?.warn?.(`[workbench_bridge] ignored response with invalid bridge identity (corr=${correlationId})`);
      return;
    }
    if (responseDelivered) return;
    responseDelivered = true;
    resolveResponse(value);
  });

  const unlistenProgress = ctx.events.listen(progressEvent, payload => {
    const value = decodeEventPayload(payload);
    if (!object(value)) return;
    if (value.correlationId !== correlationId || value.bridgeToken !== bridgeToken) {
      ctx.logger?.warn?.(`[workbench_bridge] ignored progress with invalid bridge identity (corr=${correlationId})`);
      return;
    }
    if (typeof value.message !== 'string' || value.message === '') return;
    ctx.emitProgressChunk?.(`${value.message}\n`);
  });

  const request = {
    correlationId,
    bridgeToken,
    command,
    args,
    timeoutMs: clamped,
    runId,
    toolCallId,
    sessionId,
  };

  let cancelOnDrop: CancelOnDrop | undefined;
  try {
    try {
      ctx.events.emit(ACR_BRIDGE_REQUEST, request);
    } catch (error) {
      ctx.logger?.warn?.(`[workbench_bridge] emit ${ACR_BRIDGE_REQUEST} failed: ${errorText(error)}`);
      throw new Error(`bridge emit failed: ${errorText(error)}`);
    }

    cancelOnDrop = new CancelOnDrop(() => {
      ctx.logger?.warn?.(`[workbench_bridge] bridge future dropped before terminal response (corr=${correlationId})`);
      emitBridgeCancel(ctx, cancelPayload, 'bridge future dropped');
    });

    ctx.logger?.debug?.(
      `[workbench_bridge] request sent: command=${command}, corr=${correlationId}, timeout_ms=${clamped}, run_id=${runId}`,
    );

    const drainMs = ctx.drainMs ?? CANCEL_DRAIN_MS;
    const outcome = await waitOutcome(response, clamped, ctx.cancel ?? null, ctx.channelClosed);
    if (outcome.kind === 'response') {
      cancelOnDrop.disarm();
      return parseTerminalResponse(outcome.value, correlationId, bridgeToken, command);
    }

    if (outcome.kind === 'timed_out') {
      ctx.logger?.warn?.(`[workbench_bridge] timed out after ${clamped}ms (corr=${correlationId})`);
      emitBridgeCancel(ctx, cancelPayload, 'timeout');
      const drained = await waitOutcome(response, drainMs, null, undefined);
      cancelOnDrop.disarm();
      if (drained.kind === 'response') {
        return parseTerminalResponse(drained.value, correlationId, bridgeToken, command);
      }
      throw new Error(
        `RESULT_UNKNOWN: ACR bridge timed out after ${clamped}ms and no terminal receipt arrived during ${drainMs}ms cancel drain (corr=${correlationId})`,
      );
    }

    if (outcome.kind === 'channel_closed') {
      ctx.logger?.warn?.(`[workbench_bridge] response channel closed (corr=${correlationId})`);
      emitBridgeCancel(ctx, cancelPayload, 'response channel closed');
      const drained = await waitOutcome(response, drainMs, null, undefined);
      cancelOnDrop.disarm();
      if (drained.kind === 'response') {
        return parseTerminalResponse(drained.value, correlationId, bridgeToken, command);
      }
      throw new Error(
        `RESULT_UNKNOWN: ACR bridge response channel closed after request submission (corr=${correlationId})`,
      );
    }

    ctx.logger?.info?.(`[workbench_bridge] cancelled (corr=${correlationId})`);
    emitBridgeCancel(ctx, cancelPayload, 'execution cancelled');
    const drained = await waitOutcome(response, drainMs, null, undefined);
    cancelOnDrop.disarm();
    if (drained.kind === 'response') {
      return parseTerminalResponse(drained.value, correlationId, bridgeToken, command);
    }
    throw new Error(
      `CANCELLED: ACR bridge call cancelled; no terminal receipt during ${drainMs}ms drain, result unknown — re-observe before retrying (corr=${correlationId})`,
    );
  } finally {
    unlistenResponse();
    unlistenProgress();
    // Mirrors Rust `Drop for CancelOnDrop` for any unexpected exit path.
    cancelOnDrop?.dispose();
  }
}
