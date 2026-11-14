// Port of dstu-browser/src/browser/bridge.rs pure parts: INIT_SCRIPT embedding,
// session init-script binding, envelope parsing and the script builders.
// `eval_with_result` needs native WebView callbacks (F2 shell) and is not ported.

import { readFileSync } from 'node:fs';
import { rustTrim } from '../../../platform/util/portable.ts';
import { parseSerdeJson } from '../../mcp/api.ts';
import type { BridgeError, JsonValue } from './command-result.ts';

export const INIT_SCRIPT: string = readFileSync(new URL('./browser-bridge.js', import.meta.url), 'utf8');
export const SESSION_ID_MARKER = '/*__DS_BROWSER_SESSION_ID__*/ null';
export const INPUT_NONCE_MARKER = '/*__DS_BROWSER_INPUT_NONCE__*/ null';
export const BRIDGE_GLOBAL = '__dsBrowserBridge';
export const DEFAULT_CONTENT_LABEL = 'browser-content';

export const DEFAULT_READY_TIMEOUT_MS = 2_000;
export const DEFAULT_SNAPSHOT_TIMEOUT_MS = 5_000;
export const DEFAULT_ACTION_TIMEOUT_MS = 3_000;
export const DEFAULT_FILE_ACTION_TIMEOUT_MS = 15_000;
export const DEFAULT_EVAL_TIMEOUT_MS = 10_000;

export type BridgeResult<T> = { ok: true; value: T } | { ok: false; error: BridgeError };
export type RawScriptResult = { ok: true; value: string } | { ok: false; error: string };

export interface BridgeErrorBody {
  code: string;
  message: string;
  details: JsonValue | null;
}

export class BridgeEnvelope {
  readonly ok: boolean;
  readonly v: number | null;
  readonly epoch: number | null;
  readonly data: JsonValue | undefined;
  readonly error: BridgeErrorBody | null;

  constructor(
    ok: boolean, v: number | null, epoch: number | null,
    data: JsonValue | undefined, error: BridgeErrorBody | null,
  ) {
    this.ok = ok;
    this.v = v;
    this.epoch = epoch;
    this.data = data;
    this.error = error;
  }

  intoResult(): BridgeResult<JsonValue> {
    if (this.ok) return { ok: true, value: this.data === undefined ? null : this.data };
    const error = this.error ?? {
      code: 'UNKNOWN',
      message: 'bridge returned ok=false without error',
      details: null,
    };
    return {
      ok: false,
      error: { kind: 'Bridge', code: error.code, message: error.message, details: error.details },
    };
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}
function json(value: unknown): string {
  return JSON.stringify(value);
}
function isObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function optionalUint(
  value: Record<string, JsonValue>, key: string, max: number,
): { ok: true; value: number | null } | { ok: false } {
  const current = value[key];
  if (current === undefined || current === null) return { ok: true, value: null };
  if (typeof current !== 'number' || !Number.isInteger(current) || current < 0 || current > max) {
    return { ok: false };
  }
  return { ok: true, value: current };
}

function envelopeFromValue(value: JsonValue): BridgeResult<BridgeEnvelope> {
  if (!isObject(value)) return { ok: false, error: { kind: 'InvalidJson', message: 'invalid type: expected a bridge envelope object' } };
  if (typeof value.ok !== 'boolean') {
    return { ok: false, error: { kind: 'InvalidJson', message: 'missing field `ok`' } };
  }
  const v = optionalUint(value, 'v', 4294967295);
  if (!v.ok) return { ok: false, error: { kind: 'InvalidJson', message: 'invalid value for field `v`' } };
  const epoch = optionalUint(value, 'epoch', Number.MAX_SAFE_INTEGER);
  if (!epoch.ok) return { ok: false, error: { kind: 'InvalidJson', message: 'invalid value for field `epoch`' } };
  const data = Object.hasOwn(value, 'data') ? value.data : undefined;
  let error: BridgeErrorBody | null = null;
  const rawError = value.error;
  if (rawError !== undefined && rawError !== null) {
    if (!isObject(rawError)) {
      return { ok: false, error: { kind: 'InvalidJson', message: 'invalid type for field `error`' } };
    }
    if (typeof rawError.code !== 'string') {
      return { ok: false, error: { kind: 'InvalidJson', message: 'missing field `error.code`' } };
    }
    if (typeof rawError.message !== 'string') {
      return { ok: false, error: { kind: 'InvalidJson', message: 'missing field `error.message`' } };
    }
    const details = rawError.details === undefined ? null : rawError.details;
    error = { code: rawError.code, message: rawError.message, details };
  }
  return { ok: true, value: new BridgeEnvelope(value.ok, v.value, epoch.value, data, error) };
}

/** `parse_bridge_json`: unwrap the extra JSON string layer WebView2 adds for strings. */
export function parseBridgeJson(raw: string): BridgeResult<BridgeEnvelope> {
  const trimmed = rustTrim(raw);
  if (trimmed === '') {
    return { ok: false, error: { kind: 'InvalidJson', message: 'empty script result' } };
  }
  const outer = parseSerdeJson(trimmed);
  if (!outer.ok) {
    return { ok: false, error: { kind: 'InvalidJson', message: `${outer.message}; raw=${truncate(trimmed, 200)}` } };
  }
  let parsed: JsonValue = outer.value;
  if (typeof parsed === 'string') {
    const inner = parsed;
    const nested = parseSerdeJson(inner);
    if (!nested.ok) {
      return {
        ok: false,
        error: { kind: 'InvalidJson', message: `nested string parse: ${nested.message}; inner=${truncate(inner, 200)}` },
      };
    }
    parsed = nested.value;
  }
  return envelopeFromValue(parsed);
}

/** `finish_script_result`: parse the platform callback payload. */
export function finishScriptResult(raw: RawScriptResult): BridgeResult<JsonValue> {
  if (!raw.ok) return { ok: false, error: { kind: 'Eval', message: raw.error } };
  const envelope = parseBridgeJson(raw.value);
  if (!envelope.ok) return envelope;
  return envelope.value.intoResult();
}

export function callScript(method: string, argsJson: string): string {
  return `(function(){
  try {
    var b = window.${BRIDGE_GLOBAL};
    if (!b || typeof b.${method} !== 'function') {
      return JSON.stringify({
        ok:false, v:1, epoch:0,
        error:{code:'NOT_READY', message:'${BRIDGE_GLOBAL} missing or ${method} not a function'}
      });
    }
    var result = b.${method}(${argsJson});
    if (result && typeof result.then === 'function') {
      throw new Error('async bridge methods are not supported in sync eval path');
    }
    return JSON.stringify(result);
  } catch (e) {
    return JSON.stringify({
      ok:false, v:1, epoch:0,
      error:{code:'EVAL_THROW', message: String(e && e.message || e)}
    });
  }
})()`;
}

export function callScriptNoArgs(method: string): string {
  return callScript(method, '');
}

function typeScript(argsJson: string): string {
  return `(function(){
  try {
    var b = window.${BRIDGE_GLOBAL};
    if (!b || typeof b.type !== 'function') {
      return JSON.stringify({
        ok:false, v:1, epoch:0,
        error:{code:'NOT_READY', message:'bridge type missing'}
      });
    }
    var args = ${argsJson};
    var result = b.type(args[0], args[1], args[2] || {});
    return JSON.stringify(result);
  } catch (e) {
    return JSON.stringify({
      ok:false, v:1, epoch:0,
      error:{code:'EVAL_THROW', message: String(e && e.message || e)}
    });
  }
})()`;
}

function setInputFilesScript(argsJson: string): string {
  return `(function(){
  try {
    var b = window.${BRIDGE_GLOBAL};
    if (!b || typeof b.setInputFiles !== 'function') {
      return JSON.stringify({
        ok:false, v:1, epoch:0,
        error:{code:'NOT_READY', message:'bridge setInputFiles missing'}
      });
    }
    var args = ${argsJson};
    return JSON.stringify(b.setInputFiles(args[0], args[1]));
  } catch (e) {
    return JSON.stringify({
      ok:false, v:1, epoch:0,
      error:{code:'EVAL_THROW', message: String(e && e.message || e)}
    });
  }
})()`;
}

function highlightScript(argsJson: string): string {
  return `(function(){
  try {
    var b = window.${BRIDGE_GLOBAL};
    if (!b || typeof b.highlight !== 'function') {
      return JSON.stringify({
        ok:false, v:1, epoch:0,
        error:{code:'NOT_READY', message:'bridge highlight missing'}
      });
    }
    var args = ${argsJson};
    var result = b.highlight(args[0], args[1] || {});
    return JSON.stringify(result);
  } catch (e) {
    return JSON.stringify({
      ok:false, v:1, epoch:0,
      error:{code:'EVAL_THROW', message: String(e && e.message || e)}
    });
  }
})()`;
}

export function buildTypeArgs(refId: string, text: string): string {
  return json([refId, text, { clear: true }]);
}
export function buildSetInputFilesArgs(refId: string, files: JsonValue): string {
  return json([refId, files]);
}
export function buildHighlightArgs(refId: string): string {
  return json([{ ref: refId }, { durationMs: 800 }]);
}
export function buildSnapshotArgs(interactiveOnly: boolean): string {
  return json({ interactiveOnly });
}
export function buildClickArgs(refId: string): string {
  return json({ ref: refId });
}

/** Script builders for the native bridge client (client itself needs the F2 webview surface). */
export function bridgeScripts() {
  return {
    ready: () => callScriptNoArgs('ready'),
    snapshot: (interactiveOnly: boolean) => callScript('snapshot', buildSnapshotArgs(interactiveOnly)),
    snapshotOpts: (opts: JsonValue) => callScript('snapshot', json(opts)),
    click: (refId: string) => callScript('click', buildClickArgs(refId)),
    type: (refId: string, text: string) => typeScript(buildTypeArgs(refId, text)),
    setInputFiles: (refId: string, files: JsonValue) => setInputFilesScript(buildSetInputFilesArgs(refId, files)),
    scroll: (opts: JsonValue) => callScript('scroll', json(opts)),
    highlight: (refId: string) => highlightScript(buildHighlightArgs(refId)),
  };
}

/** Bind the document-start trusted-input listener to one live session. */
export function initScriptForSession(sessionId: string, nonce: string): BridgeResult<string> {
  if (!INIT_SCRIPT.includes(SESSION_ID_MARKER) || !INIT_SCRIPT.includes(INPUT_NONCE_MARKER)) {
    return { ok: false, error: { kind: 'Other', message: 'trusted input initialization markers are missing' } };
  }
  if (nonce.length !== 32 || !/^[0-9a-fA-F]{32}$/.test(nonce)) {
    return { ok: false, error: { kind: 'Other', message: 'trusted input nonce must be 128-bit hex' } };
  }
  const sessionJson = JSON.stringify(sessionId);
  const nonceJson = JSON.stringify(nonce);
  return {
    ok: true,
    value: INIT_SCRIPT.replace(SESSION_ID_MARKER, sessionJson).replace(INPUT_NONCE_MARKER, nonceJson),
  };
}
