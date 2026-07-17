import { InputRule } from '@milkdown/prose/inputrules';
import type { EditorState, Transaction } from '@milkdown/prose/state';
import { $inputRule } from '@milkdown/utils';

import { calloutSchema } from './schema';
import { isCalloutType, type CalloutType } from './types';

/**
 * Convert a block starting with `[!type] ` (typically inside a blockquote after
 * typing `> `) into a callout node.
 */
export function applyCalloutInputRule(
  state: EditorState,
  match: RegExpMatchArray,
  start: number,
  end: number,
  calloutNodeType = state.schema.nodes.callout,
): Transaction | null {
  if (!calloutNodeType) return null;

  const rawType = (match[1] ?? '').toLowerCase();
  if (!isCalloutType(rawType)) return null;

  const type = rawType as CalloutType;
  const $start = state.doc.resolve(start);
  if ($start.start() !== start) return null;

  let blockquoteDepth = -1;
  for (let depth = $start.depth; depth > 0; depth -= 1) {
    if ($start.node(depth).type.name === 'blockquote') {
      blockquoteDepth = depth;
      break;
    }
  }

  const tr = state.tr.delete(start, end);

  if (blockquoteDepth > 0) {
    const bqPos = $start.before(blockquoteDepth);
    const updated = tr.doc.nodeAt(bqPos);
    if (!updated || updated.type.name !== 'blockquote') return null;

    const callout = calloutNodeType.create(
      { type, title: '' },
      updated.content,
    );
    return tr.replaceWith(bqPos, bqPos + updated.nodeSize, callout);
  }

  // Fallback: wrap the current textblock (e.g. user typed `> [!note] ` before
  // the blockquote input rule consumed `> `).
  const $pos = tr.doc.resolve(start);
  const blockStart = $pos.before();
  const blockNode = $pos.parent;
  const callout = calloutNodeType.create({ type, title: '' }, [blockNode]);
  return tr.replaceWith(blockStart, blockStart + blockNode.nodeSize, callout);
}

/** Also accept the full Obsidian line while still in a plain paragraph. */
export function applyFullLineCalloutInputRule(
  state: EditorState,
  match: RegExpMatchArray,
  start: number,
  end: number,
  calloutNodeType = state.schema.nodes.callout,
): Transaction | null {
  if (!calloutNodeType) return null;

  const rawType = (match[1] ?? '').toLowerCase();
  if (!isCalloutType(rawType)) return null;

  const type = rawType as CalloutType;
  const $start = state.doc.resolve(start);
  if ($start.start() !== start) return null;

  const tr = state.tr.delete(start, end);
  const $pos = tr.doc.resolve(start);
  const blockStart = $pos.before();
  const blockNode = $pos.parent;
  const callout = calloutNodeType.create({ type, title: '' }, [blockNode]);
  return tr.replaceWith(blockStart, blockStart + blockNode.nodeSize, callout);
}

export const calloutInputRule = $inputRule((ctx) => {
  const type = calloutSchema.type(ctx);
  return new InputRule(/^\[!(note|tip|warning|danger|info)]\s$/i, (state, match, start, end) =>
    applyCalloutInputRule(state, match, start, end, type),
  );
});

export const calloutFullLineInputRule = $inputRule((ctx) => {
  const type = calloutSchema.type(ctx);
  return new InputRule(/^>\s*\[!(note|tip|warning|danger|info)]\s$/i, (state, match, start, end) =>
    applyFullLineCalloutInputRule(state, match, start, end, type),
  );
});
