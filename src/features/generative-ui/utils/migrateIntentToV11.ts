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
  const next: GenerativeBlockIntent = { type: block.type };
  if (block.props !== undefined) next.props = block.props;
  if (block.id !== undefined) next.id = block.id;
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
  const migrated: GenerativeUIIntent = {
    version: '1.1',
    blocks: (intent.blocks ?? []).map((block) => normalizeBlock(block)),
  };
  if (layout) migrated.layout = layout;
  if (intent.meta !== undefined) migrated.meta = { ...intent.meta };
  return migrated;
}
