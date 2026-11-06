/** Opt-in, in-memory diagnostics. Default off; no I/O; every entry point is fail-safe. */

export const INK_DIAGNOSTICS_SCHEMA = 'deep-student.ink-diagnostics.v1' as const;
export const INK_DIAGNOSTICS_CAPACITY = 2000;

const MAX_EVENT_NAME_LENGTH = 96;
const MAX_STRING_LENGTH = 160;
const MAX_KEY_LENGTH = 64;
const MAX_OBJECT_KEYS = 32;
const MAX_ARRAY_ITEMS = 32;
const MAX_DATA_DEPTH = 4;
const MAX_DATA_VALUES = 768;
const MAX_COALESCED_SAMPLES = 24;
const MAX_REPORTED_COALESCED_COUNT = 10_000;

const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Content tokens are rejected everywhere; restricted words allow id/size/mode suffixes.
const CONTENT_KEY_TOKENS = new Set(
  ('authorization base64 blob body clipboard content cookie data exception file html image img '
    + 'markdown message msg note password path payload photo raw screenshot secret stack text '
    + 'title token trace url uri value').split(' '),
);
const RESTRICTED_OBJECT_TOKENS = new Set(['canvas', 'document', 'selection']);
const METADATA_SUFFIXES = new Set(
  ('active at bounds code count duration enabled height id ids index kind length level mode ms '
    + 'number num phase points present pressure revision samples scale size state status '
    + 'time timestamp total type version width px rect x y zoom').split(' '),
);
const SAFE_ERROR_STRING_SUFFIXES = new Set(
  'category code count kind name phase source status type'.split(' '),
);

// Critical pointer context survives the per-object key cap.
const POINTER_CONTEXT_PRIORITY_KEYS = (
  'docId documentId pageId surfaceId scope phase active activePointerId selectionMode '
  + 'selectMode mode tool gesture canvasWidth canvasHeight viewportWidth viewportHeight'
).split(' ');
const POINTER_DATA_PRIORITY_KEYS = 'context phase type pointerId'.split(' ');

const POINTER_PHASES: Readonly<Record<string, string>> = {
  pointerdown: 'down',
  pointermove: 'move',
  pointerup: 'up',
  pointercancel: 'cancel',
  gotpointercapture: 'gotcapture',
  lostpointercapture: 'lostcapture',
};

export type InkDiagnosticPrimitive = string | number | boolean | null;
export type InkDiagnosticValue =
  | InkDiagnosticPrimitive
  | InkDiagnosticValue[]
  | { [key: string]: InkDiagnosticValue };
export type InkDiagnosticData = Record<string, InkDiagnosticValue>;

/** Optional pointer-capture policy; `includeCoalesced` defaults to true. */
export interface InkPointerCaptureOptions {
  readonly includeCoalesced?: boolean;
}

export interface InkDiagnosticRecord {
  readonly seq: number;
  readonly wallTimeMs: number;
  readonly monotonicMs: number;
  readonly event: string;
  readonly data?: Readonly<InkDiagnosticData>;
}

export interface InkDiagnosticEnvironment {
  readonly language: string;
  readonly platform: string;
  readonly maxTouchPoints: number;
  readonly hardwareConcurrency: number;
  readonly visibilityState: string;
}

export interface InkDiagnosticsSnapshot {
  readonly schema: typeof INK_DIAGNOSTICS_SCHEMA;
  readonly enabled: boolean;
  readonly capacity: number;
  readonly dropped: number;
  readonly retainedCount: number;
  readonly firstSequence: number | null;
  readonly lastSequence: number | null;
  readonly generatedAt: string;
  readonly generatedAtWallMs: number;
  readonly generatedAtMonotonicMs: number;
  readonly userAgent: string;
  readonly pixelRatio: number;
  readonly environment: Readonly<InkDiagnosticEnvironment>;
  readonly records: readonly Readonly<InkDiagnosticRecord>[];
}

const EMPTY_ENVIRONMENT: Readonly<InkDiagnosticEnvironment> = Object.freeze({
  language: '',
  platform: '',
  maxTouchPoints: 0,
  hardwareConcurrency: 0,
  visibilityState: '',
});

let enabled = false;
let nextSequence = 1;
let dropped = 0;
let recordCount = 0;
let oldestIndex = 0;
let records: Array<InkDiagnosticRecord | undefined> = [];
let lastMonotonicMs = 0;
let recordInProgress = false;
const listeners = new Set<() => void>();

function nowWallMs(): number {
  try { return Date.now(); } catch { return 0; }
}

function readMonotonicMs(): number {
  try {
    const performanceApi = globalThis.performance;
    if (performanceApi && typeof performanceApi.now === 'function') {
      const value = performanceApi.now();
      if (Number.isFinite(value)) return Math.max(0, value);
    }
  } catch {
  }
  return nowWallMs();
}

function nextMonotonicMs(): number {
  lastMonotonicMs = Math.max(lastMonotonicMs, readMonotonicMs());
  return lastMonotonicMs;
}

function formatIsoTime(wallTimeMs: number): string {
  try { return new Date(wallTimeMs).toISOString(); } catch { return ''; }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readProperty(source: unknown, key: string): unknown {
  if (!source || (typeof source !== 'object' && typeof source !== 'function')) return undefined;
  try { return (source as Record<string, unknown>)[key]; } catch { return undefined; }
}

function readNumberProperty(source: unknown, key: string): number | undefined {
  const value = readProperty(source, key);
  return isFiniteNumber(value) ? value : undefined;
}

function readBooleanProperty(source: unknown, key: string): boolean | undefined {
  const value = readProperty(source, key);
  return typeof value === 'boolean' ? value : undefined;
}

function readStringProperty(source: unknown, key: string, maxLength = MAX_STRING_LENGTH): string | undefined {
  const value = readProperty(source, key);
  return typeof value === 'string' ? trimText(value, maxLength) : undefined;
}

function trimText(value: string, maxLength: number): string {
  let compact = '';
  let pendingSpace = false;
  const scanLimit = Math.min(value.length, maxLength * 4);
  for (let index = 0; index < scanLimit; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) {
      pendingSpace = compact.length > 0;
      continue;
    }
    if (pendingSpace) {
      compact += ' ';
      pendingSpace = false;
    }
    compact += value[index];
    if (compact.length > maxLength) break;
  }
  return compact.length <= maxLength ? compact : `${compact.slice(0, Math.max(0, maxLength - 1))}…`;
}

function splitDiagnosticKey(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function isSafeDiagnosticKey(key: string): boolean {
  if (!key || key.length > MAX_KEY_LENGTH || UNSAFE_OBJECT_KEYS.has(key)) return false;
  const tokens = splitDiagnosticKey(key);
  if (tokens.length === 0) return false;
  if (tokens.some((token) => CONTENT_KEY_TOKENS.has(token))) return false;
  if (!tokens.some((token) => RESTRICTED_OBJECT_TOKENS.has(token))) return true;
  return METADATA_SUFFIXES.has(tokens[tokens.length - 1]);
}

/** Keep structured error metadata; never persist `error: "TypeError: message"`. */
function isRawErrorString(key: string, value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const tokens = splitDiagnosticKey(key);
  if (!tokens.includes('error') && !tokens.includes('err')) return false;
  return !SAFE_ERROR_STRING_SUFFIXES.has(tokens[tokens.length - 1]);
}

interface SanitizeState {
  seen: WeakSet<object>;
  remaining: number;
}

function takeBudget(state: SanitizeState): boolean {
  if (state.remaining <= 0) return false;
  state.remaining -= 1;
  return true;
}

function hasOwn(source: object, key: string): boolean {
  try { return Object.prototype.hasOwnProperty.call(source, key); } catch { return false; }
}

function isPlainObject(value: object): boolean {
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch { return false; }
}

type InstanceConstructor = new (...args: never[]) => object;

function isInstanceOf(value: object, constructorName: 'Error' | 'Node' | 'Event' | 'Blob'): boolean {
  try {
    const constructor = (globalThis as Record<string, unknown>)[constructorName];
    return typeof constructor === 'function' && value instanceof (constructor as InstanceConstructor);
  } catch { return false; }
}

function opaqueObjectMarker(value: object): string {
  if (isInstanceOf(value, 'Node')) return '[dom-node]';
  if (isInstanceOf(value, 'Event')) return '[event]';
  if (isInstanceOf(value, 'Blob')) return '[blob]';
  return '[object]';
}

function sanitizeError(error: Error, state: SanitizeState): InkDiagnosticData | undefined {
  if (!takeBudget(state)) return undefined;
  const result: InkDiagnosticData = { name: readStringProperty(error, 'name', 48) || 'Error' };
  const code = readProperty(error, 'code');
  if (typeof code === 'string') result.code = trimText(code, 64);
  else if (isFiniteNumber(code)) result.code = code;
  // Never copy message, stack, cause, or arbitrary error fields.
  return result;
}

function isArrayValue(value: unknown): value is unknown[] {
  try { return Array.isArray(value); } catch { return false; }
}

function sanitizeArray(input: unknown[], depth: number, state: SanitizeState): InkDiagnosticValue[] | undefined {
  if (!takeBudget(state)) return undefined;
  const result: InkDiagnosticValue[] = [];
  let length = 0;
  try { length = Math.min(Math.max(0, Math.trunc(input.length)), MAX_ARRAY_ITEMS); } catch { return result; }
  for (let index = 0; index < length && state.remaining > 0; index += 1) {
    const sanitized = sanitizeValue(readProperty(input, String(index)), depth + 1, state);
    if (sanitized !== undefined) result.push(sanitized);
  }
  return result;
}

function sanitizeObject(
  input: object,
  depth: number,
  state: SanitizeState,
  priorityKeys?: readonly string[],
): InkDiagnosticData {
  if (!takeBudget(state)) return {};
  const result: InkDiagnosticData = {};
  const handled = new Set<string>();
  let copied = 0;

  const copy = (key: string): void => {
    if (handled.has(key)) return;
    handled.add(key);
    if (copied >= MAX_OBJECT_KEYS || state.remaining <= 0) return;
    if (!isSafeDiagnosticKey(key) || !hasOwn(input, key)) return;
    const rawValue = readProperty(input, key);
    if (isRawErrorString(key, rawValue)) return;
    const value = sanitizeValue(
      rawValue,
      depth + 1,
      state,
      key === 'context' ? POINTER_CONTEXT_PRIORITY_KEYS : undefined,
    );
    if (value === undefined) return;
    result[key] = value;
    copied += 1;
  };

  if (priorityKeys) {
    for (const key of priorityKeys) {
      if (copied >= MAX_OBJECT_KEYS || state.remaining <= 0) break;
      copy(key);
    }
  }
  try {
    for (const key in input) {
      if (copied >= MAX_OBJECT_KEYS || state.remaining <= 0) break;
      if (hasOwn(input, key)) copy(key);
    }
  } catch {
    // Return the bounded prefix already collected.
  }
  return result;
}

function sanitizeValue(
  input: unknown,
  depth: number,
  state: SanitizeState,
  priorityKeys?: readonly string[],
): InkDiagnosticValue | undefined {
  if (input === null) return null;

  switch (typeof input) {
    case 'string':
      return takeBudget(state) ? trimText(input, MAX_STRING_LENGTH) : undefined;
    case 'number':
      return takeBudget(state) && isFiniteNumber(input) ? input : undefined;
    case 'boolean':
      return takeBudget(state) ? input : undefined;
    case 'undefined':
      return undefined;
    case 'object':
      break;
    default:
      if (!takeBudget(state)) return undefined;
      return typeof input === 'bigint' ? '[bigint]' : `[${typeof input}]`;  }

  if (depth >= MAX_DATA_DEPTH) return takeBudget(state) ? '[depth-limit]' : undefined;

  const objectValue = input as object;
  if (state.seen.has(objectValue)) return takeBudget(state) ? '[circular]' : undefined;
  state.seen.add(objectValue);

  if (isInstanceOf(objectValue, 'Error')) return sanitizeError(objectValue as Error, state);
  if (isArrayValue(objectValue)) return sanitizeArray(objectValue, depth, state);
  if (!isPlainObject(objectValue)) return takeBudget(state) ? opaqueObjectMarker(objectValue) : undefined;
  return sanitizeObject(objectValue, depth, state, priorityKeys);
}

function sanitizeRecordData(event: string, input: unknown): InkDiagnosticData | undefined {
  if (input === undefined) return undefined;
  const state: SanitizeState = { seen: new WeakSet<object>(), remaining: MAX_DATA_VALUES };
  const priorityKeys = event === 'pointer' ? POINTER_DATA_PRIORITY_KEYS : undefined;
  const sanitized = sanitizeValue(input, 0, state, priorityKeys);
  if (sanitized === null || typeof sanitized !== 'object' || Array.isArray(sanitized)) return undefined;
  return sanitized as InkDiagnosticData;
}

const POINTER_NUMBER_FIELDS = (
  'timeStamp clientX clientY pressure tiltX tiltY twist width height pointerId buttons button'
).split(' ');
const POINTER_SAMPLE_FLAGS = ['isPrimary'];
const POINTER_EVENT_FLAGS = ['isPrimary', 'isTrusted', 'cancelable', 'defaultPrevented'];

function copyPointerFields(target: Record<string, unknown>, source: unknown, includeEventFlags = false): void {
  for (const key of POINTER_NUMBER_FIELDS) {
    const value = readNumberProperty(source, key);
    if (value !== undefined) target[key] = value;
  }
  const pointerType = readStringProperty(source, 'pointerType', 24);
  if (pointerType !== undefined) target.pointerType = pointerType;
  for (const key of includeEventFlags ? POINTER_EVENT_FLAGS : POINTER_SAMPLE_FLAGS) {
    const value = readBooleanProperty(source, key);
    if (value !== undefined) target[key] = value;
  }
}

function readPointerCaptureState(event: PointerEvent, pointerId: number | undefined): boolean | undefined {
  if (pointerId === undefined) return undefined;
  try {
    const target = (event.currentTarget ?? event.target) as Element | null;
    if (!target || typeof target.hasPointerCapture !== 'function') return undefined;
    return Boolean(target.hasPointerCapture(pointerId));
  } catch { return undefined; }
}

interface CoalescedData {
  count: number;
  samples: InkDiagnosticData[];
  truncated: boolean;
  failed: boolean;
  countCapped: boolean;
}

function emptyCoalescedData(failed = false): CoalescedData {
  return { count: 0, samples: [], truncated: false, failed, countCapped: false };
}

function readCoalescedData(event: PointerEvent): CoalescedData {
  let coalesced: unknown;
  try {
    const getCoalescedEvents = (event as unknown as { getCoalescedEvents?: unknown }).getCoalescedEvents;
    if (typeof getCoalescedEvents !== 'function') return emptyCoalescedData();
    coalesced = getCoalescedEvents.call(event);
  } catch { return emptyCoalescedData(true); }

  try {
    if (!isArrayValue(coalesced)) return emptyCoalescedData(true);
    const length = coalesced.length;
    if (!Number.isFinite(length) || length < 0) return emptyCoalescedData(true);

    const sampleCount = Math.min(length, MAX_COALESCED_SAMPLES);
    const samples: InkDiagnosticData[] = [];
    for (let index = 0; index < sampleCount; index += 1) {
      const item = readProperty(coalesced, String(index));
      if (!item || typeof item !== 'object') continue;
      const sample: Record<string, unknown> = {};
      copyPointerFields(sample, item);
      if (Object.keys(sample).length > 0) samples.push(sample as InkDiagnosticData);
    }

    return {
      count: Math.min(length, MAX_REPORTED_COALESCED_COUNT),
      samples,
      truncated: length > sampleCount,
      failed: false,
      countCapped: length > MAX_REPORTED_COALESCED_COUNT,
    };
  } catch { return emptyCoalescedData(true); }
}

function appendRecord(event: string, data: InkDiagnosticData | undefined): void {
  const record: InkDiagnosticRecord = {
    seq: nextSequence,
    wallTimeMs: nowWallMs(),
    monotonicMs: nextMonotonicMs(),
    event,
    ...(data ? { data } : {}),
  };
  nextSequence += 1;

  const frozen = deepFreeze(record);
  if (recordCount < INK_DIAGNOSTICS_CAPACITY) {
    records[recordCount] = frozen;
    recordCount += 1;
    return;
  }
  records[oldestIndex] = frozen;
  oldestIndex = (oldestIndex + 1) % INK_DIAGNOSTICS_CAPACITY;
  dropped += 1;
}

function notifyListeners(): void {
  for (const listener of Array.from(listeners)) {
    try { listener(); } catch { /* A broken subscriber must never affect ink input. */ }
  }
}

function readEnvironmentString(read: () => unknown, maxLength: number): string {
  try {
    const value = read();
    return typeof value === 'string' ? trimText(value, maxLength) : '';
  } catch { return ''; }
}

function readEnvironmentNumber(read: () => unknown, fallback: number, minimum = 0): number {
  try {
    const value = read();
    return isFiniteNumber(value) && value >= minimum ? value : fallback;
  } catch { return fallback; }
}

function createSnapshot(
  retainedRecords: readonly InkDiagnosticRecord[],
  generatedAtWallMs: number,
  environment: Readonly<InkDiagnosticEnvironment>,
  userAgent: string,
  pixelRatio: number,
): InkDiagnosticsSnapshot {
  const snapshot: InkDiagnosticsSnapshot = {
    schema: INK_DIAGNOSTICS_SCHEMA,
    enabled,
    capacity: INK_DIAGNOSTICS_CAPACITY,
    dropped,
    retainedCount: retainedRecords.length,
    firstSequence: retainedRecords.length > 0 ? retainedRecords[0].seq : null,
    lastSequence: retainedRecords.length > 0 ? retainedRecords[retainedRecords.length - 1].seq : null,
    generatedAt: formatIsoTime(generatedAtWallMs),
    generatedAtWallMs,
    generatedAtMonotonicMs: Math.max(lastMonotonicMs, readMonotonicMs()),
    userAgent,
    pixelRatio,
    environment,
    records: retainedRecords,
  };
  return deepFreeze(snapshot);
}

function buildSnapshot(): InkDiagnosticsSnapshot {
  const environment: InkDiagnosticEnvironment = {
    language: readEnvironmentString(() => navigator.language, 32),
    platform: readEnvironmentString(() => navigator.platform, 128),
    maxTouchPoints: readEnvironmentNumber(() => navigator.maxTouchPoints, 0),
    hardwareConcurrency: readEnvironmentNumber(() => navigator.hardwareConcurrency, 0),
    visibilityState: readEnvironmentString(() => document.visibilityState, 32),
  };
  const retained: InkDiagnosticRecord[] = [];
  for (let index = 0; index < recordCount; index += 1) {
    const stored = records[(oldestIndex + index) % INK_DIAGNOSTICS_CAPACITY];
    if (stored) retained.push(stored);
  }
  return createSnapshot(
    retained,
    nowWallMs(),
    environment,
    readEnvironmentString(() => navigator.userAgent, 512),
    readEnvironmentNumber(() => window.devicePixelRatio, 1, 0.01),
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** Defaults to false. */
export function isInkDiagnosticsEnabled(): boolean {
  return enabled;
}

/** Toggle collection; existing records are retained. */
export function setInkDiagnosticsEnabled(nextEnabled: boolean): void {
  try {
    const normalized = Boolean(nextEnabled);
    if (enabled === normalized) return;
    enabled = normalized;
    notifyListeners();
  } catch {
    // Diagnostics must not throw into feature code.
  }
}

/** Record a bounded event; no-op while disabled. */
export function recordInkDiagnostic(event: string, data?: Record<string, unknown>): void {
  if (!enabled || recordInProgress) return;
  recordInProgress = true;
  try {
    const eventName = typeof event === 'string' ? trimText(event, MAX_EVENT_NAME_LENGTH) : '';
    let safeData: InkDiagnosticData | undefined;
    try {
      safeData = data === undefined ? undefined : sanitizeRecordData(eventName, data);
    } catch {
      // Keep the event even when a hostile payload cannot be inspected.
    }
    appendRecord(eventName || 'unknown', safeData);
  } catch {
    // A diagnostics payload must never affect the feature that produced it.
  } finally {
    recordInProgress = false;
  }
}

/** Capture bounded pointer fields; coalesced reads are opt-out. */
export function captureInkPointerEvent(
  event: PointerEvent,
  context: Record<string, unknown>,
  options?: InkPointerCaptureOptions,
): void {
  if (!enabled) return;
  try {
    const eventType = readStringProperty(event, 'type', 32);
    const phase = eventType ? POINTER_PHASES[eventType] : undefined;
    if (!eventType || !phase) return;

    const data: Record<string, unknown> = { phase, type: eventType };
    copyPointerFields(data, event, true);

    const pointerId = readNumberProperty(event, 'pointerId');
    const hasPointerCapture = readPointerCaptureState(event, pointerId);
    if (hasPointerCapture !== undefined) data.hasPointerCapture = hasPointerCapture;

    // Context is inserted before coalesced samples so key caps cannot hide it.
    if (context && typeof context === 'object') data.context = context;

    if (readBooleanProperty(options, 'includeCoalesced') !== false) {
      const coalesced = readCoalescedData(event);
      data.coalescedCount = coalesced.count;
      data.coalescedSamples = coalesced.samples;
      data.coalescedTruncated = coalesced.truncated;
      data.coalescedCountCapped = coalesced.countCapped;
      if (coalesced.failed) data.coalescedFailed = true;
    } else {
      // Never imply zero coalesced events when the read was deliberately skipped.
      data.coalescedStrategy = 'skipped';
      data.coalescedSkipped = true;
    }

    recordInkDiagnostic('pointer', data);
  } catch {
    // A pointer diagnostic must never throw into a pointer handler.
  }
}

/** Return a deep-frozen, isolated snapshot. */
export function getInkDiagnosticsSnapshot(): InkDiagnosticsSnapshot {
  try {
    return buildSnapshot();
  } catch {
    return createSnapshot([], nowWallMs(), EMPTY_ENVIRONMENT, '', 1);
  }
}

/** Clear records and drop count; sequence numbers stay monotonic. */
export function clearInkDiagnostics(): void {
  try {
    records = [];
    recordCount = 0;
    oldestIndex = 0;
    dropped = 0;
    notifyListeners();
  } catch {
    // Clearing diagnostics must not throw.
  }
}

/** Notify only on enable/disable and clear; never per recorded event. */
export function subscribeInkDiagnostics(listener: () => void): () => void {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
