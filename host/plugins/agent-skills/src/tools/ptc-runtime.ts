/**
 * PTC (Programmatic Tool Composition) Starlark runtime, ported from
 * `chat_v2/tools/ptc_runtime.rs`.
 *
 * The interpreter itself is F7's `starlark 0.14.2` WASI engine; this module owns
 * the Rust-side policy that must not live in the engine: the fail-closed tool
 * allowlist, shared call budget, trace/args fingerprints, `object_read` /
 * `object_write` page I/O and their lineage bookkeeping.
 */
import { createHash } from 'node:crypto';
import type { NativeStarlark, StarlarkJson } from '../../../../platform/native/starlark/api.ts';
import { StarlarkToolFailure } from '../../../../platform/native/starlark/api.ts';
import {
  derivedEdge, managedLocator, TaskObjectHandleBuilder, type ManagedLocator,
} from './task-objects.ts';
import {
  OBJECT_READ_PAGE_MAX_BYTES, OBJECT_WRITE_MAX_BYTES, readTaskObjectPage, writeTaskObjectPage,
} from './object-pages.ts';
import { isPtcAllowed as descriptorIsPtcAllowed } from '../../../agent-orchestration/api.ts';

export const MAX_SCRIPT_BYTES = 64 * 1024;
export const DEFAULT_MAX_CALLS = 50;
export const MAX_CALLS_LIMIT = 200;
export const DEFAULT_TIMEOUT_SECS = 120;
export const MAX_TIMEOUT_SECS = 600;
export const MAX_CALLSTACK_SIZE = 256;
export const MAX_HEAP_BYTES = 32 * 1024 * 1024;
export const MAX_TICK_COUNT = 10_000_000;
export const INLINE_RESULT_MAX_CHARS = 4 * 1024;
export const RESULT_PREVIEW_CHARS = 2048;
export const OBJECT_READ_DEFAULT_LIMIT = 8 * 1024;
const CALL_RECV_POLL_MS = 100;
const TRACE_ERROR_MAX_CHARS = 300;

/** Read-only surface (G01-e registry oracle, 36 names). */
export const PTC_ALLOWED_TOOLS: readonly string[] = [
  'builtin-unified_search',
  'builtin-rag_search',
  'builtin-web_search',
  'builtin-web_fetch',
  'builtin-arxiv_search',
  'builtin-scholar_search',
  'builtin-settings_get',
  'builtin-model_assignments_get',
  'builtin-llm_usage_query',
  'builtin-backup_status',
  'builtin-backup_job_status',
  'builtin-sync_status',
  'builtin-index_status',
  'builtin-learning_overview',
  'builtin-pomodoro_today_stats',
  'builtin-pomodoro_daily_stats',
  'builtin-fsrs_get_scheduler_config',
  'builtin-memory_read',
  'builtin-memory_list',
  'builtin-resource_list',
  'builtin-resource_read',
  'builtin-resource_search',
  'builtin-folder_list',
  'builtin-dstu_list_trash',
  'builtin-user_todo_list_lists',
  'builtin-user_todo_list_items',
  'builtin-user_todo_get_summary',
  'builtin-user_todo_search',
  'builtin-user_todo_list_trash',
  'builtin-qbank_list',
  'builtin-qbank_list_questions',
  'builtin-qbank_get_question',
  'builtin-qbank_get_stats',
  'builtin-qbank_get_next_question',
  'builtin-review_get_due',
  'builtin-review_stats',
];

/** Controlled write surface (G05-P3 policy constant). */
export const PTC_WRITE_TOOLS: readonly string[] = [
  'builtin-workspace_artifact_write',
  'builtin-todo_init',
  'builtin-todo_update',
  'builtin-todo_add',
];

const PTC_WRITE_TOOL_SET = new Set(PTC_WRITE_TOOLS);

/**
 * Descriptor-backed policy (Rust `is_ptc_allowed_tool` delegates to
 * `tool_descriptors::is_ptc_allowed`). The constant above is the test oracle
 * only; production always asks the L06 registry.
 */
export interface PtcDescriptorPolicy {
  isPtcAllowed(toolName: string): boolean;
}

/** Production authority: L06's published descriptor registry. */
const DESCRIPTOR_POLICY: PtcDescriptorPolicy = { isPtcAllowed: descriptorIsPtcAllowed };

export function isPtcAllowedTool(toolName: string, policy?: PtcDescriptorPolicy): boolean {
  return (policy ?? DESCRIPTOR_POLICY).isPtcAllowed(toolName);
}

export function isPtcWritableTool(toolName: string): boolean {
  return PTC_WRITE_TOOL_SET.has(toolName);
}

export function normalizePtcToolName(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith('builtin-') ? trimmed : `builtin-${trimmed}`;
}

export interface PtcTraceEntry {
  seq: number;
  tool: string;
  args_hash: string;
  duration_ms: number;
  result_bytes: number;
  ok: boolean;
  side_effect?: boolean;
  locator?: Record<string, string>;
  written_sha256?: string;
  error?: string;
}

export interface PtcLogger {
  debug?(message: string): void;
  info?(message: string): void;
  warn?(message: string): void;
}

export interface PtcReadSource {
  rootId: string;
  relativePath: string;
  sha256: string;
}

export interface PtcDispatchEnvelope {
  ok: boolean;
  output?: unknown;
  error?: string;
}

export type PtcDispatch = (
  seq: number,
  tool: string,
  args: unknown,
) => Promise<PtcDispatchEnvelope>;

export interface PtcBrokerOptions {
  maxCalls: number;
  signal: AbortSignal;
  deadlineMs: number;
  artifactRoot?: string | null;
  dispatch: PtcDispatch;
  logger?: PtcLogger;
  descriptors?: PtcDescriptorPolicy;
  /** Engine supplied by the Host Context (`nativeStarlark`), never a direct import. */
  nativeStarlark: NativeStarlark;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = canonicalJson(record[key]);
    return out;
  }
  return value;
}

/** `sha256:` + first 16 hex chars over canonical JSON, matching Rust. */
export function argsFingerprint(args: unknown): string {
  const encoded = Buffer.from(JSON.stringify(canonicalJson(args)) ?? '', 'utf8');
  return `sha256:${createHash('sha256').update(encoded).digest('hex').slice(0, 16)}`;
}

export function truncateChars(raw: string, maxChars: number): string {
  const chars = Array.from(raw);
  return chars.length <= maxChars ? raw : `${chars.slice(0, maxChars).join('')}…[truncated]`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bytesOf(value: unknown): number {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 0 : Buffer.byteLength(serialized, 'utf8');
}

function pageLocator(value: unknown): { locator: ManagedLocator; trace: Record<string, string> } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(
      'expected a task object handle dict (with locator) or an explicit '
      + '{root_id, relative_path} locator dict',
    );
  }
  const dict = value as Record<string, unknown>;
  let locatorValue: unknown = value;
  if ('locator' in dict) {
    locatorValue = dict.locator;
  }
  if (typeof locatorValue !== 'object' || locatorValue === null || Array.isArray(locatorValue)) {
    throw new Error('locator must be a dict');
  }
  const locatorDict = locatorValue as Record<string, unknown>;
  const rootId = locatorDict.root_id ?? locatorDict.rootId;
  const relativePath = locatorDict.relative_path ?? locatorDict.relativePath;
  if (typeof rootId !== 'string') throw new Error('locator requires root_id');
  if (typeof relativePath !== 'string') throw new Error('locator requires relative_path');
  const locator = managedLocator(rootId, relativePath);
  return {
    locator,
    trace: { root_id: locator.rootId, relative_path: locator.relativePath },
  };
}

function readLocator(value: unknown): { locator: ManagedLocator; trace: Record<string, string> } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(
      'expected a task object handle dict (with locator) or an explicit '
      + '{root_id, relative_path} locator dict',
    );
  }
  const dict = value as Record<string, unknown>;
  if ('locator' in dict) {
    const capabilities = dict.capabilities;
    const readable = typeof capabilities === 'object' && capabilities !== null
      ? (capabilities as Record<string, unknown>).readable === true
      : false;
    if (!readable) {
      throw new Error('handle capabilities.readable is not true; object is not readable');
    }
  }
  return pageLocator(value);
}

function writeLocator(value: unknown): { locator: ManagedLocator; trace: Record<string, string> } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(
      'expected a task object handle dict (with locator) or an explicit '
      + '{root_id, relative_path} locator dict',
    );
  }
  const dict = value as Record<string, unknown>;
  if ('locator' in dict) {
    const capabilities = dict.capabilities;
    const writable = typeof capabilities === 'object' && capabilities !== null
      ? (capabilities as Record<string, unknown>).writable === true
      : false;
    if (!writable) {
      throw new Error('handle capabilities.writable is not true; object is not writable');
    }
  }
  return pageLocator(value);
}

const BASE64_ALPHABET
  = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * `base64 0.21.7 STANDARD.decode` (padded, canonical) with the crate's
 * `DecodeError` display messages, so `object_write` rejects exactly like Rust.
 */
function decodeStrictBase64(content: string): Buffer {
  const bytes = Buffer.from(content, 'utf8');
  const fail = (message: string): never => {
    throw new Error(`content is not valid base64: ${message}`);
  };
  if (bytes.length % 4 === 1) {
    const last = bytes[bytes.length - 1]!;
    if (last !== 0x3d && !BASE64_ALPHABET.includes(String.fromCharCode(last))) {
      fail(`Invalid byte ${last}, offset ${bytes.length - 1}.`);
    }
    fail('Encoded text cannot have a 6-bit remainder.');
  }
  let padding = 0;
  let firstPaddingIndex = 0;
  let morsels = 0;
  let lastSymbolIndex = -1;
  let lastSymbol = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index]!;
    if (byte === 0x3d) {
      if (index % 4 < 2) {
        fail(`Invalid byte 61, offset ${padding > 0 ? firstPaddingIndex : index}.`);
      }
      if (padding === 0) firstPaddingIndex = index;
      padding += 1;
      continue;
    }
    if (padding > 0) fail(`Invalid byte 61, offset ${firstPaddingIndex}.`);
    if (!BASE64_ALPHABET.includes(String.fromCharCode(byte))) {
      fail(`Invalid byte ${byte}, offset ${index}.`);
    }
    morsels += 1;
    lastSymbol = BASE64_ALPHABET.indexOf(String.fromCharCode(byte));
    lastSymbolIndex = index;
  }
  if ((padding + morsels) % 4 !== 0) fail('Invalid padding');
  const trailingMorsels = morsels % 4;
  if (trailingMorsels === 2 && (lastSymbol & 0b1111) !== 0) {
    fail(`Invalid last symbol ${bytes[lastSymbolIndex]!}, offset ${lastSymbolIndex}.`);
  }
  if (trailingMorsels === 3 && (lastSymbol & 0b11) !== 0) {
    fail(`Invalid last symbol ${bytes[lastSymbolIndex]!}, offset ${lastSymbolIndex}.`);
  }
  return Buffer.from(content, 'base64');
}

/**
 * Shared broker state. Trace/calls are mutated synchronously by the host
 * callbacks; the executor reads them after the interpreter returns (so a
 * wall-clock cancellation still carries the calls that already happened).
 */
export class PtcBrokerState {
  readonly maxCalls: number;
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
  readonly artifactRoot: string | null;
  readonly logger: PtcLogger;
  readonly nativeStarlark: NativeStarlark;
  readonly trace: PtcTraceEntry[] = [];
  private readonly dispatch: PtcDispatch;
  private readonly descriptors: PtcDescriptorPolicy | undefined;
  private callsUsedValue = 0;
  private readLog: PtcReadSource[] = [];

  constructor(options: PtcBrokerOptions) {
    this.maxCalls = options.maxCalls;
    this.signal = options.signal;
    this.deadlineMs = options.deadlineMs;
    this.artifactRoot = options.artifactRoot ?? null;
    this.dispatch = options.dispatch;
    this.logger = options.logger ?? {};
    this.descriptors = options.descriptors;
    this.nativeStarlark = options.nativeStarlark;
  }

  get callsUsed(): number { return this.callsUsedValue; }

  isCancelled(): boolean {
    return this.signal.aborted || Date.now() >= this.deadlineMs;
  }

  record(entry: PtcTraceEntry): void {
    this.trace.push(entry);
  }

  recordReadSource(source: PtcReadSource): void {
    this.readLog.push(source);
  }

  readSources(): readonly PtcReadSource[] {
    return [...this.readLog];
  }

  private nextSeq(kind: 'call' | 'read' | 'write'): number {
    if (this.callsUsedValue >= this.maxCalls) {
      if (kind === 'read') {
        throw new Error(
          `ptc_run: call budget exhausted (max_calls=${this.maxCalls}); object_read shares the `
          + 'call budget, restructure the script to page with fewer reads',
        );
      }
      if (kind === 'write') {
        throw new Error(
          `ptc_run: call budget exhausted (max_calls=${this.maxCalls}); object_write shares the `
          + 'call budget, restructure the script to write with fewer calls',
        );
      }
      throw new Error(
        `ptc_run: call budget exhausted (max_calls=${this.maxCalls}); restructure the script `
        + 'to aggregate with fewer calls',
      );
    }
    const seq = this.callsUsedValue;
    this.callsUsedValue += 1;
    return seq;
  }

  async call(tool: string, args: StarlarkJson): Promise<StarlarkJson> {
    const normalized = normalizePtcToolName(tool);
    if (normalized === 'builtin-ptc_run') {
      throw new Error('ptc_run cannot invoke itself (recursive call)');
    }
    const isWrite = isPtcWritableTool(normalized);
    if (!isWrite && !isPtcAllowedTool(normalized, this.descriptors)) {
      throw new Error(
        `ptc_run: tool '${normalized}' is not in the PTC allowlist (fail-closed). `
        + 'Callable from scripts: read-only builtin tools plus the small controlled write set '
        + '(workspace_artifact_write / todo_*).',
      );
    }
    const seq = this.nextSeq('call');
    const argsHash = argsFingerprint(args);
    const started = Date.now();
    let envelope: PtcDispatchEnvelope;
    try {
      envelope = await this.waitForDispatch(seq, normalized, args, argsHash, started, isWrite);
    } catch (error) {
      throw error;
    }
    const duration = Date.now() - started;
    if (envelope.ok) {
      this.record({
        seq,
        tool: normalized,
        args_hash: argsHash,
        duration_ms: duration,
        result_bytes: bytesOf(envelope.output),
        ok: true,
        ...(isWrite ? { side_effect: true } : {}),
      });
      return envelope.output as StarlarkJson;
    }
    const message = envelope.error ?? 'sub-tool returned failure';
    this.record({
      seq,
      tool: normalized,
      args_hash: argsHash,
      duration_ms: duration,
      result_bytes: 0,
      ok: false,
      ...(isWrite ? { side_effect: true } : {}),
      error: truncateChars(message, TRACE_ERROR_MAX_CHARS),
    });
    throw new StarlarkToolFailure(message);
  }

  private async waitForDispatch(
    seq: number,
    tool: string,
    args: unknown,
    argsHash: string,
    started: number,
    isWrite: boolean,
  ): Promise<PtcDispatchEnvelope> {
    const dispatch = this.dispatch(seq, tool, args);
    return new Promise<PtcDispatchEnvelope>((resolve, reject) => {
      let settled = false;
      const timer = setInterval(() => {
        if (settled) return;
        if (this.isCancelled()) {
          settled = true;
          clearInterval(timer);
          this.record({
            seq,
            tool,
            args_hash: argsHash,
            duration_ms: Date.now() - started,
            result_bytes: 0,
            ok: false,
            ...(isWrite ? { side_effect: true } : {}),
            error: 'cancelled or timed out while awaiting dispatch',
          });
          reject(new Error(`ptc_run: call to '${tool}' cancelled or timed out`));
        }
      }, CALL_RECV_POLL_MS);
      dispatch.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearInterval(timer);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearInterval(timer);
          reject(error);
        },
      );
    });
  }

  async objectRead(
    object: StarlarkJson,
    options: StarlarkJson,
  ): Promise<StarlarkJson> {
    if (this.isCancelled()) throw new Error('cancelled or timed out');
    const seq = this.nextSeq('read');
    const opts = (typeof options === 'object' && options !== null
      ? options : {}) as Record<string, unknown>;
    const offset = typeof opts.offset === 'number' ? opts.offset : 0;
    const limit = typeof opts.limit === 'number' ? opts.limit : OBJECT_READ_DEFAULT_LIMIT;
    const started = Date.now();
    let traceLocator: Record<string, string> = { root_id: '', relative_path: '' };
    try {
      const parsed = readLocator(object);
      traceLocator = parsed.trace;
      if (offset < 0) throw new Error(`offset must be >= 0, got ${offset}`);
      if (limit <= 0) throw new Error(`limit must be > 0, got ${limit}`);
      const effectiveLimit = Math.min(limit, OBJECT_READ_PAGE_MAX_BYTES);
      if (this.artifactRoot === null || this.artifactRoot === '') {
        throw new Error(
          'no artifacts root in this context; materialized objects are unavailable',
        );
      }
      const page = readTaskObjectPage(
        this.artifactRoot, parsed.locator, offset, effectiveLimit,
      );
      this.recordReadSource({
        rootId: parsed.locator.rootId,
        relativePath: parsed.locator.relativePath,
        sha256: page.sha256,
      });
      const argsHash = argsFingerprint({
        locator: traceLocator, offset, limit,
      });
      this.record({
        seq,
        tool: 'object_read',
        args_hash: argsHash,
        duration_ms: Date.now() - started,
        result_bytes: Buffer.byteLength(page.content, 'utf8'),
        ok: true,
      });
      return {
        content: page.content,
        encoding: page.encoding,
        offset: page.offset,
        limit: effectiveLimit,
        next_offset: page.next_offset,
        total_size: page.total_size,
        eof: page.eof,
        sha256: page.sha256,
      };
    } catch (error) {
      const message = errorText(error);
      const argsHash = argsFingerprint({ locator: traceLocator, offset, limit });
      this.record({
        seq,
        tool: 'object_read',
        args_hash: argsHash,
        duration_ms: Date.now() - started,
        result_bytes: 0,
        ok: false,
        error: truncateChars(message, TRACE_ERROR_MAX_CHARS),
      });
      throw error;
    }
  }

  async objectWrite(
    object: StarlarkJson,
    options: StarlarkJson,
  ): Promise<StarlarkJson> {
    if (this.isCancelled()) throw new Error('cancelled or timed out');
    const seq = this.nextSeq('write');
    const opts = (typeof options === 'object' && options !== null
      ? options : {}) as Record<string, unknown>;
    const content = typeof opts.content === 'string' ? opts.content : '';
    const offset = typeof opts.offset === 'number' ? opts.offset : null;
    const expectedSha256 = typeof opts.expected_sha256 === 'string'
      ? opts.expected_sha256
      : null;
    const encoding = typeof opts.encoding === 'string' ? opts.encoding : 'utf-8';
    const started = Date.now();
    let traceLocator: Record<string, string> = { root_id: '', relative_path: '' };
    try {
      const parsed = writeLocator(object);
      traceLocator = parsed.trace;
      if (offset !== null && offset < 0) {
        throw new Error(`offset must be >= 0, got ${offset}`);
      }
      let bytes: Buffer;
      if (encoding === 'utf-8') bytes = Buffer.from(content, 'utf8');
      else if (encoding === 'base64') bytes = decodeStrictBase64(content);
      else throw new Error(`unsupported encoding '${encoding}' (utf-8 | base64)`);
      if (this.artifactRoot === null || this.artifactRoot === '') {
        throw new Error('no artifacts root in this context; object writes are unavailable');
      }
      const outcome = writeTaskObjectPage(
        this.artifactRoot, parsed.locator, bytes, offset, expectedSha256, this.logger,
      );
      const sources = this.readSources();
      const edges = sources.map(source => derivedEdge(
        `${source.rootId}:${source.relativePath}#${source.sha256}`,
        'ptc.script',
      ));
      const fileName = parsed.locator.relativePath.split('/').at(-1)
        ?? parsed.locator.relativePath;
      const builder = new TaskObjectHandleBuilder(
        `ptc-write:${outcome.sha256}`,
        'artifact',
        fileName,
        'deep-student-ptc',
        this.logger,
      )
        .tool('builtin-ptc_run')
        .mediaType(encoding === 'utf-8'
          ? 'text/plain; charset=utf-8' : 'application/octet-stream')
        .sizeBytes(outcome.total_size)
        .sha256(outcome.sha256)
        .locator(parsed.locator)
        .capabilities({
          readable: true,
          materializable: true,
          writable: true,
          shareable: false,
          sendable: false,
          deletable: true,
        });
      const handle = (edges.length === 0
        ? builder.originUnknown('script wrote without reading any source object first')
        : builder.derivedEdges(edges)
      ).build();
      const argsHash = argsFingerprint({
        locator: traceLocator,
        offset,
        encoding,
        content_bytes: Buffer.byteLength(content, 'utf8'),
        content_sha256: createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex'),
      });
      this.record({
        seq,
        tool: 'object_write',
        args_hash: argsHash,
        duration_ms: Date.now() - started,
        result_bytes: outcome.written_bytes,
        ok: true,
        side_effect: true,
        locator: traceLocator,
        written_sha256: outcome.sha256,
      });
      return {
        locator: { root_id: parsed.locator.rootId, relative_path: parsed.locator.relativePath },
        sha256: outcome.sha256,
        total_size: outcome.total_size,
        written_bytes: outcome.written_bytes,
        created: outcome.created,
        object_handle: handle as unknown as StarlarkJson,
      };
    } catch (error) {
      const message = errorText(error);
      const argsHash = argsFingerprint({
        locator: traceLocator,
        offset,
        encoding,
        content_bytes: Buffer.byteLength(content, 'utf8'),
        content_sha256: createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex'),
      });
      this.record({
        seq,
        tool: 'object_write',
        args_hash: argsHash,
        duration_ms: Date.now() - started,
        result_bytes: 0,
        ok: false,
        side_effect: true,
        locator: traceLocator,
        error: truncateChars(message, TRACE_ERROR_MAX_CHARS),
      });
      throw error;
    }
  }
}

export interface PtcInterpreterLimits {
  max_callstack_size: number;
  max_heap_bytes: number;
  max_tick_count: number;
}

export function defaultPtcInterpreterLimits(): PtcInterpreterLimits {
  return {
    max_callstack_size: MAX_CALLSTACK_SIZE,
    max_heap_bytes: MAX_HEAP_BYTES,
    max_tick_count: MAX_TICK_COUNT,
  };
}

export type PtcScriptOutcome =
  | { ok: true; value: StarlarkJson }
  | { ok: false; error: string };

/** Run a script on the F7 engine with the PTC dialect and broker callbacks. */
export async function runPtcScript(
  script: string,
  broker: PtcBrokerState,
): Promise<PtcScriptOutcome> {
  return runPtcScriptWithLimits(script, broker, defaultPtcInterpreterLimits());
}

export async function runPtcScriptWithLimits(
  script: string,
  broker: PtcBrokerState,
  limits: PtcInterpreterLimits,
): Promise<PtcScriptOutcome> {
  try {
    const value = await broker.nativeStarlark.evaluate(script, {
      limits,
      signal: broker.signal,
      deadlineMs: broker.deadlineMs,
      call: (tool, args) => broker.call(tool, args),
      objectRead: (object, options) => broker.objectRead(object, options),
      objectWrite: (object, options) => broker.objectWrite(object, options),
    });
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

export { OBJECT_READ_PAGE_MAX_BYTES, OBJECT_WRITE_MAX_BYTES };
