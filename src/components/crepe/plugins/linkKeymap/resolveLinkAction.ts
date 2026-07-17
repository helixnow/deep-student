/**
 * Mod-K 链接快捷键：根据选区解析应对 LinkTooltip 执行的动作。
 * 无选区 → null（no-op）；已有 link mark → edit；否则 → add。
 */

import type { Mark } from '@milkdown/prose/model';
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
 * 解析 Mod-K 应对当前选区做的事。
 * @returns null 表示应 no-op（空选区或无 link mark type）
 */
export function resolveLinkKeymapAction(state: EditorState): LinkKeymapAction | null {
  const { selection } = state;
  if (selection.empty) return null;

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
