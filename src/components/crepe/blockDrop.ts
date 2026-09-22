import type { EditorView } from '@milkdown/prose/view';
import { resolveBlockTarget, type BlockTarget } from './blockTarget';
import { prepareCrepeBlockMove } from './blockMenuCommands';

export interface CrepeBlockDrop {
  kind: 'before' | 'after' | 'inside';
  pos: number;
  containerPos: number;
  rect: DOMRect;
  valid: boolean;
  reason?: 'self' | 'schema';
}

/** Hit-test both axes (two columns can have the same Y). Structural wrappers may
 * receive drops into their content, but never become the dragged block itself. */
export function resolveCrepeBlockDrop(view: EditorView, source: BlockTarget, point: { x: number; y: number }): CrepeBlockDrop | null {
  let hit: { pos: number; depth: number; rect: DOMRect; distance: number; structural: boolean } | null = null;
  view.state.doc.descendants((node, pos) => {
    if (!node.isBlock) return;
    const structural = node.type.name === 'ds_column' || node.type.name === 'toggleBody';
    if (!structural && node.type.name !== 'toggleTitle' && !node.type.spec.group?.split(' ').includes('block')
      && !['list_item', 'listItem'].includes(node.type.name)) return;
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement) || dom.closest('[hidden], [inert]')) return false;
    const rect = dom.getBoundingClientRect();
    if (!rect.height || !rect.width) return false;
    const dx = Math.max(rect.left - point.x, point.x - rect.right, 0);
    const dy = Math.max(rect.top - point.y, point.y - rect.bottom, 0);
    const distance = dx + dy * 2;
    const depth = view.state.doc.resolve(pos).depth + 1;
    if (!hit || distance < hit.distance || (distance === hit.distance && depth > hit.depth)) hit = { pos, depth, rect, distance, structural };
  });
  if (!hit) return null;
  const chosen = hit as { pos: number; depth: number; rect: DOMRect; structural: boolean };
  const target = chosen.structural ? null : resolveBlockTarget(view, chosen.pos);
  const nodePos = target?.pos ?? chosen.pos;
  const node = view.state.doc.nodeAt(nodePos)!;
  let containerPos = nodePos;
  let contentStart = nodePos + 1;
  let contentEnd = contentStart + node.content.size;
  const relativeY = (point.y - chosen.rect.top) / chosen.rect.height;
  const inside = chosen.structural || (!node.isTextblock && !node.isLeaf
    && relativeY > 0.25 && relativeY < 0.75 && point.x >= chosen.rect.left + 12);
  if (node.type.name === 'toggle') {
    containerPos = nodePos + 1 + node.child(0).nodeSize;
    contentStart = containerPos + 1;
    contentEnd = contentStart + node.child(1).content.size;
  }
  const kind = inside ? 'inside' : relativeY < 0.5 ? 'before' : 'after';
  const pos = inside ? contentEnd : kind === 'before' ? nodePos : nodePos + node.nodeSize;
  const self = nodePos >= source.pos && nodePos < source.to;
  const valid = !self && Boolean(prepareCrepeBlockMove(view, source, pos));
  return { kind, pos, containerPos: inside ? containerPos : view.state.doc.resolve(pos).depth
    ? view.state.doc.resolve(pos).before(view.state.doc.resolve(pos).depth) : -1,
    rect: chosen.rect, valid, reason: valid ? undefined : self ? 'self' : 'schema' };
}
