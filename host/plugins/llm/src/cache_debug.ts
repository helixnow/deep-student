/**
 * Prompt-cache 分叉点定位（model2_pipeline.rs cache_debug_*）。
 * 对 post-adapter 最终请求体按缓存语义切四段取指纹，与同作用域上一请求对比。
 */
import { sha256HexSync } from '../../../platform/crypto/sync.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';
import { chatV2StreamIdentity } from './stream_scope.ts';
import { logInfo } from './logging.ts';

type JsonObject = { [key: string]: JsonValue };

export const CACHE_DEBUG_SEGMENT_NAMES = ['system', 'tools', 'history', 'current_user'] as const;
export type CacheDebugSegmentName = typeof CACHE_DEBUG_SEGMENT_NAMES[number];
export const CACHE_DEBUG_MAX_TRACKED_SCOPES = 256;

export interface CacheDebugHistoryItem {
  id: string | null;
  hash: string;
}

export interface CacheDebugSnapshot {
  segments: [string, string, string, string];
  historyItems: CacheDebugHistoryItem[];
  toolNames: string[];
}

function isObject(value: unknown): value is JsonObject {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value);
}

function roleOf(value: unknown): string | null {
  if (!isObject(value)) return null;
  return typeof value.role === 'string' ? value.role : null;
}

/** 把最终请求体切成 system/tools/history/current_user 四段。 */
export function cacheDebugSplitBodySegments(
  body: unknown,
): [JsonValue, JsonValue, JsonValue, JsonValue] {
  if (!isObject(body)) return [null, null, null, null];
  const systemParts: JsonValue[] = [];
  for (const key of ['instructions', 'system', 'systemInstruction', 'system_instruction']) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      systemParts.push({ [key]: body[key]! });
    }
  }
  const messageList = ['messages', 'input', 'contents']
    .map((key) => body[key])
    .find((value): value is JsonValue[] => Array.isArray(value));

  const history: JsonValue[] = [];
  let currentUser: JsonValue = null;
  if (messageList !== undefined) {
    const items = [...messageList];
    const tail = items.at(-1);
    if (tail !== undefined && roleOf(tail) === 'user') currentUser = items.pop()!;
    for (const item of items) {
      const role = roleOf(item);
      if (role === 'system' || role === 'developer') systemParts.push(item);
      else history.push(item);
    }
  }
  return [systemParts, body.tools ?? null, history, currentUser];
}

export function cacheDebugHash16(value: unknown): string {
  const digest = sha256HexSync(JSON.stringify(value));
  return digest.slice(0, 16);
}

export function cacheDebugMessageId(item: unknown): string | null {
  if (!isObject(item)) return null;
  for (const key of ['id', 'message_id', 'messageId', 'client_id', 'uuid']) {
    const value = item[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

export function cacheDebugHistoryItems(history: unknown): CacheDebugHistoryItem[] {
  if (!Array.isArray(history)) return [];
  return history.map((item) => ({ id: cacheDebugMessageId(item), hash: cacheDebugHash16(item) }));
}

/** 工具名有序序列（function.name 优先）。 */
export function cacheDebugToolNames(body: unknown): string[] {
  if (!isObject(body) || !Array.isArray(body.tools)) return [];
  const names: string[] = [];
  for (const item of body.tools) {
    if (!isObject(item)) continue;
    const fn = item.function;
    const fnName = isObject(fn) && typeof fn.name === 'string' ? fn.name : null;
    const directName = typeof item.name === 'string' ? item.name : null;
    const name = fnName ?? directName;
    if (name !== null) names.push(name);
  }
  return names;
}

/** (最长逐位相同前缀, 新增工具名)。 */
export function cacheDebugToolFaceDelta(
  previous: string[], current: string[],
): [number, string[]] {
  const shared = Math.min(previous.length, current.length);
  let prefixKept = 0;
  while (prefixKept < shared && previous[prefixKept] === current[prefixKept]) prefixKept += 1;
  const added = current.filter((name) => !previous.includes(name));
  return [prefixKept, added];
}

export function cacheDebugSnapshot(body: unknown): CacheDebugSnapshot {
  const segments = cacheDebugSplitBodySegments(body);
  const historyItems = cacheDebugHistoryItems(segments[2]);
  return {
    segments: segments.map((segment) => cacheDebugHash16(segment)) as CacheDebugSnapshot['segments'],
    historyItems,
    toolNames: cacheDebugToolNames(body),
  };
}

/** 四段各自字符数。 */
export function cacheDebugSegmentSizes(body: unknown): [number, number, number, number] {
  return cacheDebugSplitBodySegments(body).map(
    (segment) => [...JSON.stringify(segment)].length,
  ) as [number, number, number, number];
}

/** 请求体摘要：消息数、总字符数、role 计数（BTreeMap 顺序）。 */
export function cacheDebugBodySummary(body: unknown): [number, number, string] {
  const chars = [...JSON.stringify(body)].length;
  let messages = 0;
  const roles = new Map<string, number>();
  for (const key of ['messages', 'input', 'contents']) {
    if (!isObject(body)) break;
    const items = body[key];
    if (!Array.isArray(items)) continue;
    messages = items.length;
    for (const item of items) {
      const role = (isObject(item) && typeof item.role === 'string' ? item.role : null) ?? 'other';
      roles.set(role, (roles.get(role) ?? 0) + 1);
    }
    break;
  }
  const rolesText = [...roles.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([role, count]) => `${role}:${count}`)
    .join(',');
  return [messages, chars, rolesText];
}

/** history 段首个分叉：索引、上次消息 id、本次消息 id。 */
export function cacheDebugHistoryDivergence(
  previous: CacheDebugHistoryItem[],
  current: CacheDebugHistoryItem[],
): [number, string | null, string | null] | null {
  const shared = Math.min(previous.length, current.length);
  for (let index = 0; index < shared; index += 1) {
    if (previous[index]!.hash !== current[index]!.hash) {
      return [index, previous[index]!.id, current[index]!.id];
    }
  }
  if (previous.length !== current.length) {
    return [shared, previous[shared]?.id ?? null, current[shared]?.id ?? null];
  }
  return null;
}

export function cacheDebugSegmentFingerprints(body: unknown): [string, string, string, string] {
  return cacheDebugSplitBodySegments(body).map(
    (segment) => cacheDebugHash16(segment),
  ) as [string, string, string, string];
}

/** 按前缀顺序返回首个分叉段名。 */
export function cacheDebugFirstDivergentSegment(
  previous: [string, string, string, string],
  current: [string, string, string, string],
): CacheDebugSegmentName | null {
  for (let index = 0; index < CACHE_DEBUG_SEGMENT_NAMES.length; index += 1) {
    if (previous[index] !== current[index]) return CACHE_DEBUG_SEGMENT_NAMES[index]!;
  }
  return null;
}

const fingerprintStore = new Map<string, CacheDebugSnapshot>();

/** model2_pipeline.rs:4469; caller applies the original debug gate. */
export function logPostAdapterFingerprint(streamEvent: string, model: string, body: JsonValue): void {
  const identity = chatV2StreamIdentity(streamEvent);
  const scope = identity === null ? streamEvent : `${identity.sessionId}::${identity.variantId ?? '-'}`;
  const snapshot = cacheDebugSnapshot(body), previous = fingerprintStore.get(scope);
  const divergence = previous === undefined ? 'baseline' : cacheDebugFirstDivergentSegment(previous.segments, snapshot.segments) ?? 'none';
  const historyDivergence = previous === undefined ? null : cacheDebugHistoryDivergence(previous.historyItems, snapshot.historyItems);
  const toolDelta = previous === undefined ? null : cacheDebugToolFaceDelta(previous.toolNames, snapshot.toolNames);
  if (!fingerprintStore.has(scope) && fingerprintStore.size >= CACHE_DEBUG_MAX_TRACKED_SCOPES) fingerprintStore.clear();
  fingerprintStore.set(scope, snapshot);
  const [system, tools, history, currentUser] = snapshot.segments;
  logInfo(`[PromptCache] post-adapter fingerprint: model=${model}, scope=${scope}, system=${system}, tools=${tools}, history=${history}, current_user=${currentUser}, first_divergent_segment=${divergence}`);
  const sizes = cacheDebugSegmentSizes(body);
  const [messageCount, bodyChars, roles] = cacheDebugBodySummary(body);
  const first = snapshot.historyItems[0], last = snapshot.historyItems.at(-1);
  const anchor = first === undefined || last === undefined ? 'empty'
    : `first=${first.id ?? '#0'}:${first.hash},last=${last.id ?? '#last'}:${last.hash}`;
  const toolNames = snapshot.toolNames.length === 0 ? 'none' : cacheDebugHash16(snapshot.toolNames);
  const deltaText = toolDelta === null ? 'baseline'
    : `prefix_kept=${toolDelta[0]},added=${toolDelta[1].length === 0 ? 'none' : `${toolDelta[1].length}[${toolDelta[1].slice(0, 8).join('|')}]`}`;
  const detail = historyDivergence === null ? 'none'
    : `index=${historyDivergence[0]},prev=${historyDivergence[1] ?? `#${historyDivergence[0]}`},curr=${historyDivergence[2] ?? `#${historyDivergence[0]}`}`;
  logInfo(`[PromptCache] fingerprint detail: scope=${scope}, seg_len=[system=${sizes[0]},tools=${sizes[1]},history=${sizes[2]},current_user=${sizes[3]}], history=[count=${snapshot.historyItems.length},anchor=${anchor}], tools=[count=${snapshot.toolNames.length},names=${toolNames},${deltaText}], body=[messages=${messageCount},chars=${bodyChars},roles=${roles}], divergence=[${detail}]`);
}
