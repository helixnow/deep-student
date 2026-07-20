import { InputRule } from '@milkdown/prose/inputrules';
import type { EditorState, Transaction } from '@milkdown/prose/state';
import { $inputRule } from '@milkdown/utils';

import { calloutSchema } from './schema';
import { isCalloutType, type CalloutType } from './types';

/**
 * 触发正则（供 InputRule 与单测共用）。
 * 容错：全角 `！`、可选 `-`/`+` 折叠后缀、终止符可为空白或半/全角冒号。
 */
export const CALLOUT_INPUT_RULE_RE =
  /^\[[!！](note|tip|warning|danger|info)\]([+-])?(?:\s|[:：])$/i;

export const CALLOUT_FULL_LINE_INPUT_RULE_RE =
  /^>\s*\[[!！](note|tip|warning|danger|info)\]([+-])?(?:\s|[:：])$/i;

function matchedCollapsed(match: RegExpMatchArray): boolean {
  return match[2] === '-';
}

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
  const collapsed = matchedCollapsed(match);
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
      { type, title: '', collapsed },
      updated.content,
    );
    return tr.replaceWith(bqPos, bqPos + updated.nodeSize, callout);
  }

  // Fallback: wrap the current textblock (e.g. user typed `> [!note] ` before
  // the blockquote input rule consumed `> `).
  const $pos = tr.doc.resolve(start);
  const blockStart = $pos.before();
  const blockNode = $pos.parent;
  const callout = calloutNodeType.create({ type, title: '', collapsed }, [blockNode]);
  return tr.replaceWith(blockStart, blockStart + blockNode.nodeSize, callout);
}

/** Also accept the full callout line while still in a plain paragraph. */
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
  const collapsed = matchedCollapsed(match);
  const $start = state.doc.resolve(start);
  if ($start.start() !== start) return null;

  const tr = state.tr.delete(start, end);
  const $pos = tr.doc.resolve(start);
  const blockStart = $pos.before();
  const blockNode = $pos.parent;
  const callout = calloutNodeType.create({ type, title: '', collapsed }, [blockNode]);
  return tr.replaceWith(blockStart, blockStart + blockNode.nodeSize, callout);
}

export const calloutInputRule = $inputRule((ctx) => {
  const type = calloutSchema.type(ctx);
  return new InputRule(CALLOUT_INPUT_RULE_RE, (state, match, start, end) =>
    applyCalloutInputRule(state, match, start, end, type),
  );
});

export const calloutFullLineInputRule = $inputRule((ctx) => {
  const type = calloutSchema.type(ctx);
  return new InputRule(CALLOUT_FULL_LINE_INPUT_RULE_RE, (state, match, start, end) =>
    applyFullLineCalloutInputRule(state, match, start, end, type),
  );
});
