import type { Ctx } from '@milkdown/ctx';
import { editorViewCtx, serializerCtx } from '@milkdown/kit/core';
import { closeHistory } from '@milkdown/prose/history';
import { normalizeMarkdown } from '../../normalizeMarkdown';
import { isBlockTargetCurrent, type BlockTarget } from '../../blockTarget';
import { BLOCK_ID_ATTR, newBlockId } from './markdown';

/** Validate the complete authoritative draft AND the original input, which may
 * contain syntax the mounted editor has already omitted. No dispatch on failure. */
export function ensureRootBlockIds(ctx: Ctx, target: BlockTarget,
  fullMarkdown: string, originalMarkdown: string): string[] {
  preflightRootBlockIdentity(ctx, target, fullMarkdown, originalMarkdown);
  const view = ctx.get(editorViewCtx);
  const tr = view.state.tr;
  const ids: string[] = [];
  view.state.doc.forEach((node, pos, index) => {
    if (!(BLOCK_ID_ATTR in node.attrs)) throw new Error('This block does not support a persistent identity.');
    if (index === view.state.doc.childCount - 1 && node.type.name === 'paragraph' && !node.content.size && pos !== target.pos) return;
    const id = node.attrs[BLOCK_ID_ATTR] || newBlockId();
    if (index >= target.fromIndex && index < target.toIndex) ids.push(id);
    if (!node.attrs[BLOCK_ID_ATTR]) tr.setNodeMarkup(pos, undefined, { ...node.attrs, [BLOCK_ID_ATTR]: id });
  });
  if (tr.docChanged) {
    normalizeMarkdown(ctx, ctx.get(serializerCtx)(tr.doc));
    view.dispatch(closeHistory(tr));
  }
  return ids;
}

export function preflightRootBlockIdentity(ctx: Ctx, target: BlockTarget,
  fullMarkdown: string, originalMarkdown: string): void {
  const view = ctx.get(editorViewCtx);
  if (!view.editable || !isBlockTargetCurrent(view, target)) throw new Error('Block selection changed. Select the blocks again.');
  if (target.depth !== 1 || target.parentPos !== -1) throw new Error('Stable block links and cross-page moves currently support top-level blocks only.');
  normalizeMarkdown(ctx, originalMarkdown);
  const full = normalizeMarkdown(ctx, fullMarkdown);
  if (full !== normalizeMarkdown(ctx, ctx.get(serializerCtx)(view.state.doc))) {
    throw new Error('Load the complete note before creating block identities.');
  }
}
