/**
 * WAVE0 normalisation candidates (X5 → C2 review).
 *
 * Input: two raw takes of the same scenario on side A (A1, A2). Every A1/A2 difference
 * becomes either a *candidate rule* (a recognised dynamic id, timestamp or temp path,
 * proven to differ by these two takes) or an *unrepeatable* finding. Nothing is
 * auto-accepted: every rule carries `c2: 'pending'`, raw takes are never modified.
 *
 * Never normalised: event/array counts or order, keys present in only one take,
 * null vs value, error type or fixed text, numbers that are not timestamp-shaped
 * (durations, counts, precision), and text outside a recognised token. Those are
 * reported as unrepeatable so a non-repeatable business branch cannot pass.
 *
 * Dynamic ids are mapped by value to stable slots (`<id:1>`…): every occurrence of the
 * value is replaced consistently across returns, events, channel names and request
 * bodies, so FK/cross references stay checkable. A value that pairs with two different
 * counterparts is an `id-mapping-conflict`, not a rule.
 *
 * Paths are reported both as JSONPath (§3 `normalize`) and JSON Pointer (the current
 * X7 record/json.mjs `normalize` accepts pointers only and masks the whole value, which
 * cannot express substring/id-slot transforms; see audit §WAVE0 coordination).
 */
import type { RecordedEvent, RecordedStep, StreamRecord } from './recorder.ts';
import { captureJson, encodeWireJson, nativeJson, parseWireJson } from './wire-json.ts';

export type CandidateKind = 'dynamic-id' | 'temp-path' | 'timestamp' | 'llm-origin';

export interface CandidateRule {
  scenario: string;
  jsonPath: string;
  pointer: string;
  /** Array indices replaced by `*`, for grouping in review only; application uses exact `pointer`. */
  pattern: string;
  kind: CandidateKind;
  /** String values: token index within `skeleton`; null for a whole numeric value. */
  tokenIndex: number | null;
  skeleton: string | null;
  a1: string | number;
  a2: string | number;
  /** Id/temp-path slot shared by every occurrence of the value. */
  slot: string | null;
  transform: string;
  reason: string;
  c2: 'pending';
}

export interface Unrepeatable {
  scenario: string;
  jsonPath: string;
  pointer: string;
  reason: string;
  a1: unknown;
  a2: unknown;
}

export interface CandidateReport {
  format: 'x5.normalize-candidates.v0';
  scenario: string;
  /** Only side `A` reports are C2 input; a `B` report is a self-repeat check of the B backend. */
  side: 'A' | 'B';
  takes: [string, string];
  candidates: CandidateRule[];
  unrepeatable: Unrepeatable[];
  /** `unrepeatable`: A itself is not repeatable here; C2 must decide before any B comparison is judged. */
  verdict: 'candidates-only' | 'identical' | 'unrepeatable';
}

type Segment = string | number;

const TOKEN = new RegExp([
  '(?<id>[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})',
  '(?<ts>\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?)',
  '(?<tmp>(?:/tmp|/var/folders|/private/var/folders)(?:/[^\\s"\'/]+)+)',
  '(?<hex>(?<![0-9a-fA-F])[0-9a-fA-F]{32}(?![0-9a-fA-F]))',
].join('|'), 'g');

interface Token { kind: 'id' | 'ts' | 'tmp'; value: string; start: number; end: number }

export function tokenize(text: string): { skeleton: string; tokens: Token[] } {
  const tokens: Token[] = [];
  let skeleton = '';
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const groups = match.groups!;
    const kind = groups.ts !== undefined ? 'ts' : groups.tmp !== undefined ? 'tmp' : 'id';
    tokens.push({ kind, value: match[0], start: match.index, end: match.index + match[0].length });
    skeleton += `${text.slice(last, match.index)}⟨${kind}⟩`;
    last = match.index + match[0].length;
  }
  return { skeleton: skeleton + text.slice(last), tokens };
}

const TIMESTAMP_KEY = /^(timestamp|createdAt|updatedAt|startedAt|endedAt|completedAt|created_at|updated_at|started_at|ended_at|completed_at)$/;
/** 2000-01-01 .. 2100-01-01, in seconds or milliseconds. */
const plausibleEpoch = (value: number) => (value >= 946_684_800 && value < 4_102_444_800)
  || (value >= 946_684_800_000 && value < 4_102_444_800_000);

const pointerOf = (path: Segment[]) => path.map(key => `/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
const jsonPathOf = (path: Segment[]) => `$${path.map(key => typeof key === 'number' ? `[${key}]` : /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`).join('')}`;
const patternOf = (path: Segment[]) => jsonPathOf(path.map(key => typeof key === 'number' ? -1 : key)).replaceAll('[-1]', '[*]');

const LLM_ORIGIN = '${llm.origin}';

function replaceStrings(value: unknown, pairs: ReadonlyArray<readonly [string, string]>): unknown {
  if (nativeJson.isRawJSON(value)) return value;
  if (typeof value === 'string') return pairs.reduce((text, [raw, slot]) => text.split(raw).join(slot), value);
  if (Array.isArray(value)) return value.map(item => replaceStrings(item, pairs));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [replaceStrings(k, pairs) as string, replaceStrings(v, pairs)]));
  }
  return value;
}

/**
 * Strip the take label; substitute the runner-injected LLM service origin (a known input,
 * recorded in `llmOrigin`) only when a rule says so. Everything else is compared.
 */
type ComparisonRecord = Omit<StreamRecord, 'events' | 'steps'> & {
  events: Omit<RecordedEvent, 'payloadJson'>[];
  steps: Omit<RecordedStep, 'argsJson' | 'valueJson'>[];
};

/** Display projections never decide numeric equality when wire evidence is available. */
function wireView(record: StreamRecord): ComparisonRecord {
  return { ...record,
    events: record.events.map(({ payloadJson, ...event }) => ({ ...event,
      payload: typeof payloadJson === 'string' ? parseWireJson(payloadJson) : event.payload })),
    steps: record.steps.map(({ argsJson, valueJson, ...step }) => ({ ...step,
      args: typeof argsJson === 'string' ? parseWireJson(argsJson) : step.args,
      value: typeof valueJson === 'string' ? parseWireJson(valueJson) : step.value })),
  };
}

function comparable(record: StreamRecord, substituteOrigin: boolean): Record<string, unknown> {
  const { take: _take, llmOrigin, ...rest } = wireView(record);
  return substituteOrigin && llmOrigin ? replaceStrings(rest, [[llmOrigin, LLM_ORIGIN]]) as Record<string, unknown> : rest;
}

export function candidateRules(a1: StreamRecord, a2: StreamRecord): CandidateReport {
  if (a1.scenario !== a2.scenario || a1.side !== a2.side || a1.take === a2.take) {
    throw new Error(`candidate rules need two distinct takes of one scenario on one side (got ${a1.side}/${a1.take}:${a1.scenario}, ${a2.side}/${a2.take}:${a2.scenario})`);
  }
  const scenario = a1.scenario;
  const candidates: CandidateRule[] = [];
  const unrepeatable: Unrepeatable[] = [];
  const slotOfA1 = new Map<string, string>();
  const slotOfA2 = new Map<string, string>();
  const counters = { id: 0, tmp: 0 };
  const bad = (path: Segment[], reason: string, x: unknown, y: unknown) =>
    unrepeatable.push({ scenario, jsonPath: jsonPathOf(path), pointer: pointerOf(path), reason, a1: x, a2: y });

  // Old recordings and A taps that only saw parsed objects cannot establish precision,
  // even when their already-rounded display values happen to compare equal.
  for (const record of [a1, a2]) {
    const missing = (path: Segment[], raw: unknown) => {
      if (typeof raw !== 'string') bad(path, `missing raw JSON in ${record.take}; unsupported for precision proof`, null, null);
    };
    record.events.forEach((event, i) => missing(['events', i, 'payload'], event.payloadJson));
    record.steps.forEach((step, i) => {
      missing(['steps', i, 'args'], step.argsJson);
      missing(['steps', i, 'value'], step.valueJson);
    });
  }

  const slotFor = (kind: 'id' | 'tmp', x: string, y: string): string | null => {
    const sx = slotOfA1.get(x), sy = slotOfA2.get(y);
    if (sx === undefined && sy === undefined) {
      const slot = kind === 'id' ? `<id:${++counters.id}>` : `<tmp:${++counters.tmp}>`;
      slotOfA1.set(x, slot); slotOfA2.set(y, slot);
      return slot;
    }
    return sx !== undefined && sx === sy ? sx : null;
  };

  const walk = (x: unknown, y: unknown, path: Segment[]) => {
    if (Object.is(x, y)) return;
    if (nativeJson.isRawJSON(x) || nativeJson.isRawJSON(y)) {
      const numeric = (v: unknown) => typeof v === 'number' || nativeJson.isRawJSON(v);
      if (numeric(x) && numeric(y) && encodeWireJson(x) === encodeWireJson(y)) return;
      bad(path, numeric(x) && numeric(y) ? 'wire number differs (precision is not normalised)' : 'type differs', x, y);
      return;
    }
    if (typeof x === 'number' && typeof y === 'number') {
      const key = path.at(-1);
      if (typeof key === 'string' && TIMESTAMP_KEY.test(key) && plausibleEpoch(x) && plausibleEpoch(y)) {
        candidates.push({ scenario, jsonPath: jsonPathOf(path), pointer: pointerOf(path), pattern: patternOf(path), kind: 'timestamp',
          tokenIndex: null, skeleton: null, a1: x, a2: y, slot: null, transform: `replace number at ${pointerOf(path)} with "<ts>"`,
          reason: `epoch-shaped ${key} differs between A takes`, c2: 'pending' });
      } else bad(path, 'number differs (not a timestamp-shaped key; duration/count/precision are not normalised)', x, y);
      return;
    }
    if (typeof x === 'string' && typeof y === 'string') {
      const tx = tokenize(x), ty = tokenize(y);
      if (tx.skeleton !== ty.skeleton) { bad(path, 'text differs outside recognised dynamic tokens', x, y); return; }
      tx.tokens.forEach((token, index) => {
        const other = ty.tokens[index]!;
        if (token.value === other.value) return;
        const base = { scenario, jsonPath: jsonPathOf(path), pointer: pointerOf(path), pattern: patternOf(path),
          tokenIndex: index, skeleton: tx.skeleton, c2: 'pending' as const };
        if (token.kind === 'ts') {
          candidates.push({ ...base, kind: 'timestamp', a1: token.value, a2: other.value, slot: null,
            transform: `replace token #${index} of string at ${pointerOf(path)} with "<ts>"`, reason: 'datetime token differs between A takes' });
          return;
        }
        let v1 = token.value, v2 = other.value;
        if (token.kind === 'tmp') {
          // The temp root is the path up to the first differing segment (mkdtemp suffix).
          const s1 = v1.split('/'), s2 = v2.split('/');
          let i = 0;
          while (i < s1.length && s1[i] === s2[i]) i++;
          v1 = s1.slice(0, i + 1).join('/'); v2 = s2.slice(0, i + 1).join('/');
        }
        const slot = slotFor(token.kind, v1, v2);
        if (slot === null) { bad(path, `id-mapping-conflict: ${v1} / ${v2} pair with different counterparts elsewhere`, x, y); return; }
        candidates.push({ ...base, kind: token.kind === 'tmp' ? 'temp-path' : 'dynamic-id', a1: v1, a2: v2, slot,
          transform: `replace every occurrence of this take's value with "${slot}" (record-wide, consistent across returns/events/FK)`,
          reason: token.kind === 'tmp' ? 'temp directory root differs between A takes' : 'generated id differs between A takes' });
      });
      return;
    }
    if (x === null || y === null || typeof x !== 'object' || typeof y !== 'object' || Array.isArray(x) !== Array.isArray(y)) {
      bad(path, x === null || y === null ? 'null vs value' : 'type differs', x, y);
      return;
    }
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length) { bad([...path, 'length'], 'array/event count differs (order and count are never normalised)', x.length, y.length); return; }
      x.forEach((item, index) => walk(item, y[index], [...path, index]));
      return;
    }
    const ox = x as Record<string, unknown>, oy = y as Record<string, unknown>;
    for (const key of [...new Set([...Object.keys(ox), ...Object.keys(oy)])].sort()) {
      if (!Object.hasOwn(ox, key) || !Object.hasOwn(oy, key)) { bad([...path, key], `key present only in ${Object.hasOwn(ox, key) ? a1.take : a2.take}`, ox[key], oy[key]); continue; }
      walk(ox[key], oy[key], [...path, key]);
    }
  };
  // The LLM service port is chosen by the OS per take and passed in by the runner; it is not
  // backend output. Proven by the recorded origins themselves, one record-wide rule.
  const originDiffers = typeof a1.llmOrigin === 'string' && typeof a2.llmOrigin === 'string' && a1.llmOrigin !== a2.llmOrigin;
  if (originDiffers) {
    candidates.push({ scenario, jsonPath: '$.llmOrigin', pointer: '/llmOrigin', pattern: '$.llmOrigin', kind: 'llm-origin',
      tokenIndex: null, skeleton: null, a1: a1.llmOrigin!, a2: a2.llmOrigin!, slot: LLM_ORIGIN,
      transform: `replace every occurrence of this take's own llmOrigin with "${LLM_ORIGIN}"`,
      reason: 'runner-injected LLM service origin (ephemeral port) differs between takes', c2: 'pending' });
  } else if (a1.llmOrigin !== a2.llmOrigin) bad(['llmOrigin'], 'llmOrigin present in only one take', a1.llmOrigin, a2.llmOrigin);
  walk(comparable(a1, originDiffers), comparable(a2, originDiffers), []);
  return { format: 'x5.normalize-candidates.v0', scenario, side: a1.side, takes: [a1.take, a2.take], candidates, unrepeatable,
    verdict: unrepeatable.length ? 'unrepeatable' : candidates.length ? 'candidates-only' : 'identical' };
}

function at(root: unknown, pointer: string): { parent: Record<string, unknown> | unknown[]; key: string | number } | null {
  const keys = pointer.split('/').slice(1).map(key => key.replaceAll('~1', '/').replaceAll('~0', '~'));
  let parent: unknown = root;
  for (const key of keys.slice(0, -1)) {
    if (parent === null || typeof parent !== 'object' || !Object.hasOwn(parent, key)) return null;
    parent = (parent as Record<string, unknown>)[key];
  }
  const last = keys.at(-1);
  if (last === undefined || parent === null || typeof parent !== 'object' || !Object.hasOwn(parent, last)) return null;
  return { parent: parent as Record<string, unknown>, key: Array.isArray(parent) ? Number(last) : last };
}

/**
 * Apply reviewed rules to any take (A1, A2 or B). Each rule binds this take's own value
 * at the exact pointer; a skeleton/type mismatch leaves the value untouched (the diff
 * then shows it). Returns a copy; the raw record is not modified.
 */
export function applyRules(record: StreamRecord, rules: readonly CandidateRule[]): {
  normalized: StreamRecord; unbound: CandidateRule[]; conflicts: string[];
} {
  const unbound: CandidateRule[] = [];
  const conflicts: string[] = [];
  // Rules were derived on the origin-substituted record, so substitute first (take label kept as is).
  const originRule = rules.find(rule => rule.kind === 'llm-origin');
  const origin = originRule && typeof record.llmOrigin === 'string' ? record.llmOrigin : null;
  if (originRule && origin === null) unbound.push(originRule);
  const { take: label, ...body } = wireView(structuredClone(record));
  const out = { ...(origin === null ? body : replaceStrings(body, [[origin, LLM_ORIGIN]]) as typeof body), take: label };
  const root = out as unknown as Record<string, unknown>;
  const slotByValue = new Map<string, string>();
  const valueBySlot = new Map<string, string>();
  const timestampEdits: Array<() => void> = [];
  for (const rule of rules) {
    if (rule.kind === 'llm-origin') continue;
    const target = at(root, rule.pointer);
    const current = target ? (target.parent as Record<string | number, unknown>)[target.key] : undefined;
    if (rule.tokenIndex === null) {
      if (typeof current === 'number' && plausibleEpoch(current)) {
        timestampEdits.push(() => { (target!.parent as Record<string | number, unknown>)[target!.key] = '<ts>'; });
      } else unbound.push(rule);
      continue;
    }
    if (typeof current !== 'string') { unbound.push(rule); continue; }
    const { skeleton, tokens } = tokenize(current);
    const token = tokens[rule.tokenIndex];
    if (skeleton !== rule.skeleton || !token) { unbound.push(rule); continue; }
    if (rule.kind === 'timestamp') {
      timestampEdits.push(() => {
        const now = (target!.parent as Record<string | number, unknown>)[target!.key] as string;
        (target!.parent as Record<string | number, unknown>)[target!.key] = now.slice(0, token.start) + '<ts>' + now.slice(token.end);
      });
      continue;
    }
    let value = token.value;
    if (rule.kind === 'temp-path') {
      const depth = String(rule.a1).split('/').length;
      value = value.split('/').slice(0, depth).join('/');
    }
    const slot = rule.slot!;
    const priorSlot = slotByValue.get(value), priorValue = valueBySlot.get(slot);
    if ((priorSlot !== undefined && priorSlot !== slot) || (priorValue !== undefined && priorValue !== value)) {
      conflicts.push(`${rule.pointer}#${rule.tokenIndex}: ${value} vs ${slot} (bound ${priorSlot ?? '-'} / ${priorValue ?? '-'})`);
      continue;
    }
    slotByValue.set(value, slot); valueBySlot.set(slot, value);
  }
  // Positional timestamp edits first (token offsets refer to the raw string), then record-wide id slots.
  for (const edit of timestampEdits.reverse()) edit();
  const pairs: Array<readonly [string, string]> = [...slotByValue].sort((x, y) => y[0].length - x[0].length);
  const { take, ...rest } = out;
  const view = { ...(replaceStrings(rest, pairs) as Omit<ComparisonRecord, 'take'>), take };
  // Re-serialize the lossless comparison view, not its rounded display. The original take
  // is untouched; the returned copy carries the transformed wire and matching display.
  const normalized: StreamRecord = { ...view,
    events: view.events.map((event, i) => {
      const captured = captureJson(event.payload, typeof record.events[i]!.payloadJson === 'string'
        ? encodeWireJson(event.payload) : null, false);
      return { ...event, payload: captured.value, payloadJson: captured.json };
    }),
    steps: view.steps.map((step, i) => {
      const original = record.steps[i]!;
      const args = captureJson(step.args, typeof original.argsJson === 'string' ? encodeWireJson(step.args) : null, false);
      const value = captureJson(step.value, typeof original.valueJson === 'string' ? encodeWireJson(step.value) : null, false);
      return { ...step, args: args.value, argsJson: args.json, value: value.value, valueJson: value.json };
    }),
  };
  return { normalized, unbound, conflicts };
}
