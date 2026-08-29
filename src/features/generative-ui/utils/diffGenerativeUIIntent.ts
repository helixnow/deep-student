/**
 * 比较两个 GenerativeUIIntent 的 blocks：按 id（优先）或 type+index 对齐。
 * 纯函数：只读，不改输入。
 */

import type { GenerativeBlockIntent, GenerativeUIIntent } from '../types';

/** 块身份：有 id 用 id，否则 `${type}:${index}` */
export type GenerativeBlockIdentity = string;

export interface DiffGenerativeUIIntentResult {
  added: GenerativeBlockIdentity[];
  removed: GenerativeBlockIdentity[];
  changed: GenerativeBlockIdentity[];
}

function isNonEmptyId(id: unknown): id is string {
  return typeof id === 'string' && id.trim().length > 0;
}

/** 块身份：优先 id，否则 type + 数组下标 */
export function generativeBlockIdentity(
  block: Pick<GenerativeBlockIntent, 'id' | 'type'>,
  index: number,
): GenerativeBlockIdentity {
  if (isNonEmptyId(block.id)) return block.id;
  return `${block.type}:${index}`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeys(obj[key]);
    }
    return sorted;
  }
  return value;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortKeys(left)) === JSON.stringify(sortKeys(right));
}

function blocksContentEqual(left: GenerativeBlockIntent, right: GenerativeBlockIntent): boolean {
  return (
    left.type === right.type &&
    left.span === right.span &&
    deepEqual(left.props, right.props)
  );
}

function listBlocks(intent: GenerativeUIIntent | null | undefined): GenerativeBlockIntent[] {
  return Array.isArray(intent?.blocks) ? intent.blocks : [];
}

function indexByIdentity(
  blocks: readonly GenerativeBlockIntent[],
): Map<GenerativeBlockIdentity, GenerativeBlockIntent> {
  const map = new Map<GenerativeBlockIdentity, GenerativeBlockIntent>();
  blocks.forEach((block, index) => {
    const key = generativeBlockIdentity(block, index);
    if (!map.has(key)) map.set(key, block);
  });
  return map;
}

/**
 * 比较 before → after 的块增删改。
 * 身份：有非空 id 用 id，否则 `${type}:${index}`。
 * 同身份但 type / props / span 不同记为 changed；重排且内容相同不算变更。
 */
export function diffGenerativeUIIntent(
  before: GenerativeUIIntent | null | undefined,
  after: GenerativeUIIntent | null | undefined,
): DiffGenerativeUIIntentResult {
  const beforeBlocks = listBlocks(before);
  const afterBlocks = listBlocks(after);
  const beforeMap = indexByIdentity(beforeBlocks);
  const afterMap = indexByIdentity(afterBlocks);

  const added: GenerativeBlockIdentity[] = [];
  const removed: GenerativeBlockIdentity[] = [];
  const changed: GenerativeBlockIdentity[] = [];

  beforeMap.forEach((block, key) => {
    if (!afterMap.has(key)) removed.push(key);
    else if (!blocksContentEqual(block, afterMap.get(key)!)) changed.push(key);
  });

  afterMap.forEach((_, key) => {
    if (!beforeMap.has(key)) added.push(key);
  });

  return { added, removed, changed };
}
