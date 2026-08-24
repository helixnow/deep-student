/**
 * 为缺失 block.id 的意图补上确定性 id。
 * 不信任模型：只保留已有非空字符串 id，其余按 type + 下标生成。
 * 浅拷贝 intent / blocks，不改 props / span / type / layout / meta / version。
 */

export const GENERATED_BLOCK_ID_PREFIX = 'gen-block';

const INVALID_TYPE_CHARS_RE = /[^a-zA-Z0-9_-]+/g;
const REPEATED_DASH_RE = /-{2,}/g;
const EDGE_DASH_RE = /^-+|-+$/g;
const MAX_SANITIZED_TYPE_LENGTH = 48;

export type AssignableBlock = {
  type: string;
  id?: string;
  props?: Record<string, unknown>;
  span?: 1 | 2 | 3;
};

function isPreservedId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0;
}

/** type → id 片段：仅 [a-zA-Z0-9_-]，其余变 `-`，折叠重复，最长 48；空则 `block`。 */
function sanitizeTypeForId(type: string): string {
  if (typeof type !== 'string' || type.length === 0) return 'block';
  const sanitized = type
    .replace(INVALID_TYPE_CHARS_RE, '-')
    .replace(REPEATED_DASH_RE, '-')
    .replace(EDGE_DASH_RE, '')
    .slice(0, MAX_SANITIZED_TYPE_LENGTH);
  return sanitized.length > 0 ? sanitized : 'block';
}

export function makeStableBlockId(type: string, index: number): string {
  return `${GENERATED_BLOCK_ID_PREFIX}-${sanitizeTypeForId(type)}-${index}`;
}

function nextUniqueGeneratedId(base: string, usedIds: Set<string>): string {
  if (!usedIds.has(base)) return base;
  let suffix = 1;
  let candidate = `${base}-${suffix}`;
  while (usedIds.has(candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

export function assignStableBlockIds<T extends { blocks: Array<AssignableBlock> }>(
  intent: T,
): T {
  const sourceBlocks = intent.blocks;
  const usedIds = new Set<string>();
  for (const block of sourceBlocks) {
    if (isPreservedId(block.id)) usedIds.add(block.id);
  }

  const blocks = sourceBlocks.map((block, index) => {
    if (isPreservedId(block.id)) return block;
    const id = nextUniqueGeneratedId(makeStableBlockId(block.type, index), usedIds);
    usedIds.add(id);
    return { ...block, id };
  });

  return { ...intent, blocks };
}
