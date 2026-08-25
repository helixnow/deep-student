/**
 * 确定性迁移：v1 intent → v1.1（可选 layout）。
 * 已是 1.1 则规范化 layout / span；非法 columns/span 钳制到 1|2|3。
 * 不丢弃任何 block（不做 schema 过滤）。
 */

import { clampGenerativeLayoutUnit } from '../schema';
import type {
  GenerativeBlockIntent,
  GenerativeLayout,
  GenerativeLayoutMode,
  GenerativeUIIntent,
} from '../types';

export interface MigrateIntentToV11Layout {
  mode: GenerativeLayoutMode;
  columns?: unknown;
}

export interface MigrateIntentToV11Options {
  layout?: MigrateIntentToV11Layout;
}

function cloneJsonValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonValue(item)) as T;
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJsonValue(item)]),
    ) as T;
  }
  return value;
}

function normalizeMode(mode: unknown): GenerativeLayoutMode {
  return mode === 'grid' ? 'grid' : 'stack';
}

function normalizeLayout(
  layout: { mode?: unknown; columns?: unknown } | undefined,
): GenerativeLayout | undefined {
  if (layout == null) return undefined;
  const mode = normalizeMode(layout.mode);
  if (layout.columns === undefined) {
    return { mode };
  }
  return { mode, columns: clampGenerativeLayoutUnit(layout.columns) };
}

function normalizeBlock(block: GenerativeBlockIntent): GenerativeBlockIntent {
  // This is a version migration rather than a schema filter. Keep additive
  // block fields from imported/future documents and detach nested JSON props
  // so editing the migrated document cannot mutate the persisted v1 source.
  const next = cloneJsonValue(block);
  if (block.span !== undefined) next.span = clampGenerativeLayoutUnit(block.span);
  return next;
}

/**
 * 将任意合法/宽松 intent 升到 v1.1 并规范化 layout / span。
 * `options.layout` 若提供则覆盖原 layout（columns 仍会钳制）。
 */
export function migrateIntentToV11(
  intent: GenerativeUIIntent,
  options: MigrateIntentToV11Options = {},
): GenerativeUIIntent {
  const layout = normalizeLayout(options.layout ?? intent.layout);
  // Preserve additive top-level fields for lossless upgrades. Generative UI
  // intents cross persistence/import boundaries and are JSON-compatible.
  const migrated = cloneJsonValue(intent);
  migrated.version = '1.1';
  migrated.blocks = (intent.blocks ?? []).map((block) => normalizeBlock(block));
  if (layout) migrated.layout = layout;
  else delete migrated.layout;
  return migrated;
}
