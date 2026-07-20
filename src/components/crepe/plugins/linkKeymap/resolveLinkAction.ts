/**
 * Mod-K 链接快捷键：根据选区解析应对 LinkTooltip 执行的动作。
 * 有选区 → 已有 link mark 则 edit，否则 add；
 * 无选区 → 光标在链接内则 edit 整段链接，否则扩选当前词后 add；
 * 光标处无词可扩 → null（no-op）。
 */

import type { Mark, ResolvedPos } from '@milkdown/prose/model';
import type { EditorState } from '@milkdown/prose/state';

export type LinkKeymapAction =
  | { type: 'add'; from: number; to: number }
  | { type: 'edit'; from: number; to: number; mark: Mark };

/**
 * 在 [from, to) 内找第一个 link mark（及该 mark 覆盖的文本范围）。
 * 若选区跨多个链接，取第一个命中的 mark。
 */
function findLinkMarkInRange(
  state: EditorState,
  from: number,
  to: number,
): { mark: Mark; from: number; to: number } | null {
  const linkType = state.schema.marks.link;
  if (!linkType) return null;

  let found: { mark: Mark; from: number; to: number } | null = null;

  state.doc.nodesBetween(from, to, (node, pos) => {
    if (found || !node.isText) return;
    const mark = linkType.isInSet(node.marks);
    if (!mark) return;
    found = {
      mark,
      from: pos,
      to: pos + node.nodeSize,
    };
    return false;
  });

  return found;
}

/**
 * 光标落在链接内时，返回同一 mark 连续覆盖的完整范围。
 */
function findLinkRangeAtCaret(
  state: EditorState,
  $pos: ResolvedPos,
): { mark: Mark; from: number; to: number } | null {
  const linkType = state.schema.marks.link;
  if (!linkType) return null;

  const mark =
    linkType.isInSet($pos.marks()) ??
    ($pos.nodeAfter ? linkType.isInSet($pos.nodeAfter.marks) : undefined);
  if (!mark) return null;

  const parent = $pos.parent;
  const blockStart = $pos.start();
  const pos = $pos.pos;

  const segments: Array<{ from: number; to: number }> = [];
  let offset = blockStart;
  parent.forEach((child) => {
    if (child.isText && mark.isInSet(child.marks)) {
      const last = segments[segments.length - 1];
      if (last && last.to === offset) {
        last.to = offset + child.nodeSize;
      } else {
        segments.push({ from: offset, to: offset + child.nodeSize });
      }
    }
    offset += child.nodeSize;
  });

  const seg = segments.find((s) => s.from <= pos && pos <= s.to);
  return seg ? { mark, from: seg.from, to: seg.to } : null;
}

const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;

/**
 * 以光标为中心向两侧扩到词边界（字母/数字/下划线，含 CJK）。
 * 光标处无词字符 → null。
 */
export function findWordRangeAtCaret($pos: ResolvedPos): { from: number; to: number } | null {
  const parent = $pos.parent;
  if (!parent.isTextblock) return null;

  // 保持偏移一一对应：非文本 inline 节点占位为 \ufffc（非词字符，天然为边界）
  const text = parent.textBetween(0, parent.content.size, undefined, '\ufffc');
  const offset = $pos.parentOffset;

  const before = offset > 0 ? text[offset - 1] : '';
  const after = offset < text.length ? text[offset] : '';
  if (!WORD_CHAR_RE.test(before) && !WORD_CHAR_RE.test(after)) return null;

  let startOffset = offset;
  while (startOffset > 0 && WORD_CHAR_RE.test(text[startOffset - 1]!)) startOffset -= 1;
  let endOffset = offset;
  while (endOffset < text.length && WORD_CHAR_RE.test(text[endOffset]!)) endOffset += 1;
  if (startOffset === endOffset) return null;

  const blockStart = $pos.start();
  return { from: blockStart + startOffset, to: blockStart + endOffset };
}

/**
 * 解析 Mod-K 应对当前选区做的事。
 * @returns null 表示应 no-op（无 link mark type，或光标处既无链接也无词）
 */
export function resolveLinkKeymapAction(state: EditorState): LinkKeymapAction | null {
  if (!state.schema.marks.link) return null;
  const { selection } = state;

  if (selection.empty) {
    const linkRange = findLinkRangeAtCaret(state, selection.$from);
    if (linkRange) {
      return { type: 'edit', ...linkRange };
    }
    const wordRange = findWordRangeAtCaret(selection.$from);
    if (!wordRange) return null;

    const existing = findLinkMarkInRange(state, wordRange.from, wordRange.to);
    if (existing) {
      return { type: 'edit', from: existing.from, to: existing.to, mark: existing.mark };
    }
    return { type: 'add', from: wordRange.from, to: wordRange.to };
  }

  const { from, to } = selection;
  const existing = findLinkMarkInRange(state, from, to);
  if (existing) {
    return {
      type: 'edit',
      from: existing.from,
      to: existing.to,
      mark: existing.mark,
    };
  }

  return { type: 'add', from, to };
}
