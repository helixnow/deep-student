import { rustTrim } from '../../../platform/util/index.ts';
import type { TokenUsage, ToolResultInfo } from '../../../../contracts/ipc/generated/L04-chat-session.ts';
import type { JsonValue } from '../api.ts';
import { accumulate, hasTokens } from './token-usage.ts';
import { compareUtf8 } from '../../../platform/util/portable.ts';
import { createHasherSync } from '../../../platform/crypto/sync.ts';

export const RESPONSES_FINAL_REASONING_KEY = '__final_assistant__';

/** session.metadata keys for the frozen tool-face prefix (types.rs:380-430). */
export const FROZEN_TOOL_SCHEMA_ORDER_METADATA_KEY = 'frozenToolSchemaOrder';
export const TOOL_FACE_PREFIX_GENERATION_METADATA_KEY = 'toolFacePrefixGeneration';
export const TOOL_SCHEMA_DIGEST_METADATA_KEY = 'toolSchemaDigest';

/** types.rs::ToolFacePrefixSnapshot (serde camelCase). */
export interface ToolFacePrefixSnapshot {
  generation: number;
  order: string[];
  schemaDigest: string | null;
}

export function emptyToolFacePrefixSnapshot(): ToolFacePrefixSnapshot {
  return { generation: 0, order: [], schemaDigest: null };
}

type Schema = Record<string, unknown>;
function asSchema(value: unknown): Schema | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Schema : null;
}
export function toolSchemaSortKey(tool: unknown): string {
  const schema = asSchema(tool);
  const fromFunction = asSchema(schema?.function)?.name;
  if (typeof fromFunction === 'string') return fromFunction;
  return typeof schema?.name === 'string' ? schema.name : '';
}
/** Rust sort_by is stable; JS Array#sort is stable in Node 24. Byte order matches UTF-8 Ord. */
export function sortToolSchemasForPromptCache(tools: unknown[]): void {
  tools.sort((a, b) => compareUtf8(toolSchemaSortKey(a), toolSchemaSortKey(b)));
}
export function freezeToolSchemaOrderForPromptCache(tools: unknown[], frozenNames: string[]): void {
  if (frozenNames.length === 0) {
    sortToolSchemasForPromptCache(tools);
  } else {
    const frozenIndex = new Map(frozenNames.map((name, index) => [name, index] as const));
    tools.sort((a, b) => {
      const keyA = toolSchemaSortKey(a);
      const keyB = toolSchemaSortKey(b);
      const indexA = frozenIndex.get(keyA);
      const indexB = frozenIndex.get(keyB);
      if (indexA !== undefined && indexB !== undefined) return indexA - indexB;
      if (indexA !== undefined) return -1;
      if (indexB !== undefined) return 1;
      return compareUtf8(keyA, keyB);
    });
  }
  for (const tool of tools) {
    const key = toolSchemaSortKey(tool);
    if (key === '' || frozenNames.includes(key)) continue;
    frozenNames.push(key);
  }
}
export function mergeFrozenToolSchemaOrderBaseline(entry: string[], baseline: readonly string[]): void {
  for (const name of baseline) if (!entry.includes(name)) entry.push(name);
}
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  const objectA = asSchema(a);
  const objectB = asSchema(b);
  if (objectA === null || objectB === null) return false;
  const keysA = Object.keys(objectA);
  const keysB = Object.keys(objectB);
  return keysA.length === keysB.length && keysA.every(key => Object.hasOwn(objectB, key) && deepEqual(objectA[key], objectB[key]));
}
/** Window-level byte freeze: every seen tool is rewritten from frozen bytes, regardless of equality. */
export function freezeToolSchemasForPromptCache(tools: unknown[], frozenNames: string[],
  frozenSchemas: Map<string, unknown>): void {
  freezeToolSchemaOrderForPromptCache(tools, frozenNames);
  for (let index = 0; index < tools.length; index++) {
    const key = toolSchemaSortKey(tools[index]);
    if (key === '') continue;
    if (frozenSchemas.has(key)) tools[index] = frozenSchemas.get(key);
    else frozenSchemas.set(key, tools[index]);
  }
}
/** serde_json::to_string order: insertion order, matching preserve_order. */
function serializeSchema(schema: unknown): string { return JSON.stringify(schema); }
export function toolSchemaDigest(frozenSchemas: Map<string, unknown>): string | null {
  if (frozenSchemas.size === 0) return null;
  const names = [...frozenSchemas.keys()].sort((a, b) => compareUtf8(a, b));
  const hash = createHasherSync('SHA-256');
  for (const name of names) {
    hash.update(name);
    hash.update(Uint8Array.from([0x1f]));
    hash.update(serializeSchema(frozenSchemas.get(name)));
    hash.update(Uint8Array.from([0x1e]));
  }
  return hash.digestHex();
}
export function freezeToolFaceForPromptCache(tools: unknown[], frozenNames: string[],
  frozenSchemas: Map<string, unknown>): string | null {
  freezeToolSchemasForPromptCache(tools, frozenNames, frozenSchemas);
  return toolSchemaDigest(frozenSchemas);
}
export function assignToolRoundReasoningItems(dest: Map<string, JsonValue>,
  items: readonly (readonly [string | null, JsonValue])[], fallbackToolCallId: string | null): void {
  for (const [paired, item] of items) {
    if (paired !== null) dest.set(paired, item);
    else if (fallbackToolCallId !== null && !dest.has(fallbackToolCallId)) dest.set(fallbackToolCallId, item);
  }
}
export function assignFinalRoundReasoningItems(dest: Map<string, JsonValue>,
  items: readonly (readonly [string | null, JsonValue])[]): void {
  for (const [paired, item] of items) dest.set(paired ?? RESPONSES_FINAL_REASONING_KEY, item);
}
/** tool_loop.rs:342-351: retain usage reported before a failed terminal event. */
export function retainFailedRoundUsage(totalUsage: TokenUsage, reportedUsage: TokenUsage | null): TokenUsage | null {
  const reported = reportedUsage !== null && hasTokens(reportedUsage) ? reportedUsage : null;
  if (reported !== null) accumulate(totalUsage, reported);
  return reported;
}
export function requiredFieldsForEmptyToolCall(call: { name: string; arguments: unknown },
  schemas: ReadonlyMap<string, unknown>): string[] | null {
  const args = asSchema(call.arguments);
  if (args === null || Object.keys(args).length !== 0) return null;
  const functionSchema = asSchema(asSchema(schemas.get(call.name))?.function);
  const parameters = asSchema(functionSchema?.parameters);
  const required = parameters?.required;
  if (!Array.isArray(required)) return null;
  const fields = required.filter((value): value is string => typeof value === 'string' && rustTrim(value) !== '');
  return fields.length ? fields : null;
}
export function mergeRoundResultsInCallOrder(calls: readonly { id: string }[],
  executed: ToolResultInfo[], synthetic: ToolResultInfo[]): ToolResultInfo[] {
  const pool: (ToolResultInfo | null)[] = [...executed, ...synthetic];
  const merged: ToolResultInfo[] = [];
  for (const call of calls) {
    const index = pool.findIndex(info => info !== null && info.toolCallId === call.id);
    if (index !== -1) { merged.push(pool[index]!); pool[index] = null; }
  }
  for (const info of pool) if (info !== null) merged.push(info);
  return merged;
}

// ============================================================================
// Tool-face prefix generation: fan-out convergence, metadata restore, advance
// ============================================================================

function isStringPrefix(value: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= value.length && prefix.every((name, index) => value[index] === name);
}

/**
 * Join convergence: merge variant-local orders in variant-index order
 * (append-only). A true fork exists when any local order is not a prefix of
 * the converged order; only then does the generation advance by one.
 */
export function convergeToolFaceOrdersByVariantIndex(
  baselines: readonly (readonly string[])[]): { generationBump: number; order: string[] } {
  const converged: string[] = [];
  for (const localOrder of baselines) mergeFrozenToolSchemaOrderBaseline(converged, localOrder);
  const trueFork = baselines.some(localOrder => !isStringPrefix(converged, localOrder));
  return { generationBump: trueFork ? 1 : 0, order: converged };
}

function asPlainObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * repo::tool_face_prefix_from_metadata. Missing generation reads as 0 (legacy
 * sessions); order falls back to frozenToolSchemaOrder; all three keys absent
 * means the session never froze tools.
 */
export function toolFacePrefixFromMetadata(metadata: unknown): ToolFacePrefixSnapshot | null {
  const object = asPlainObject(metadata);
  if (object === null) return null;

  const rawGeneration = object[TOOL_FACE_PREFIX_GENERATION_METADATA_KEY];
  const generation = typeof rawGeneration === 'number'
    && Number.isInteger(rawGeneration) && rawGeneration >= 0 ? rawGeneration : undefined;
  const rawDigest = object[TOOL_SCHEMA_DIGEST_METADATA_KEY];
  const schemaDigest = typeof rawDigest === 'string' ? rawDigest : undefined;
  const rawOrder = object[FROZEN_TOOL_SCHEMA_ORDER_METADATA_KEY];
  const order = Array.isArray(rawOrder)
    ? rawOrder.filter((name): name is string => typeof name === 'string')
    : [];

  if (generation === undefined && schemaDigest === undefined && order.length === 0) return null;
  return { generation: generation ?? 0, order, schemaDigest: schemaDigest ?? null };
}

/**
 * repo::advance_session_tool_face_prefix (logic mirror). Order merges
 * append-only, generation only moves forward via max, a snapshot without a
 * digest never erases the persisted one, and a no-op change skips the write
 * entirely (metadata stays byte-identical).
 */
export function advanceToolFacePrefixIntoMetadata(metadata: unknown,
  snapshot: ToolFacePrefixSnapshot): { metadata: unknown; wrote: boolean } {
  const persisted = toolFacePrefixFromMetadata(metadata);
  const persistedGeneration = persisted?.generation ?? 0;
  const persistedDigest = persisted?.schemaDigest ?? null;
  const mergedOrder = persisted ? [...persisted.order] : [];
  const mergedLengthBefore = mergedOrder.length;
  mergeFrozenToolSchemaOrderBaseline(mergedOrder, snapshot.order);
  const nextGeneration = Math.max(persistedGeneration, snapshot.generation);
  const nextDigest = snapshot.schemaDigest ?? persistedDigest;

  if (nextGeneration === persistedGeneration
    && mergedOrder.length === mergedLengthBefore
    && nextDigest === persistedDigest) {
    return { metadata, wrote: false };
  }

  const object: Record<string, unknown> = asPlainObject(metadata) !== null
    ? { ...(metadata as Record<string, unknown>) }
    : {};
  object[TOOL_FACE_PREFIX_GENERATION_METADATA_KEY] = nextGeneration;
  object[FROZEN_TOOL_SCHEMA_ORDER_METADATA_KEY] = mergedOrder;
  if (nextDigest !== null) object[TOOL_SCHEMA_DIGEST_METADATA_KEY] = nextDigest;
  return { metadata: object, wrote: true };
}

/**
 * Locked in-memory refill after a miss: first writer wins, later writers merge
 * append-only without bumping, generation only ratchets up, digest only fills
 * an empty slot.
 */
export function refillToolFaceBaseline(map: Map<string, ToolFacePrefixSnapshot>, sessionId: string,
  persisted: ToolFacePrefixSnapshot): ToolFacePrefixSnapshot {
  const entry = map.get(sessionId) ?? emptyToolFacePrefixSnapshot();
  mergeFrozenToolSchemaOrderBaseline(entry.order, persisted.order);
  entry.generation = Math.max(entry.generation, persisted.generation);
  if (entry.schemaDigest === null) entry.schemaDigest = persisted.schemaDigest;
  map.set(sessionId, entry);
  return { generation: entry.generation, order: [...entry.order], schemaDigest: entry.schemaDigest };
}
