import { invoke } from '@tauri-apps/api/core';
import { editorViewCtx, parserCtx, serializerCtx } from '@milkdown/kit/core';
import { EditorState } from '@milkdown/prose/state';
import { diffChars } from 'diff';
import type { FullDocumentSearchApi, FullDocumentSnapshot } from './fullDocument';
import type { AIReviewScope } from './officialDiffContract';
import type { NoteLeaseAuth } from './noteHostCoordinator';

/** Map a serializer probe's UTF-16 boundary back through context-dependent Markdown
 * escaping. The probe lives only in an immutable PM document, never in the view. */
function sourceOffset(source: string, probed: string, marker: string): number {
  const at = probed.indexOf(marker);
  if (at < 0 || probed.indexOf(marker, at + marker.length) !== -1) throw new Error('无法精确定位所选范围。');
  const without = probed.slice(0, at) + probed.slice(at + marker.length);
  let from = 0, to = 0;
  for (const part of diffChars(without, source)) {
    if (part.added) { to += part.value.length; continue; }
    if (from + part.value.length >= at) return to + (part.removed ? 0 : at - from);
    from += part.value.length;
    if (!part.removed) to += part.value.length;
  }
  return source.length;
}

export function resolveNoteReviewScope(api: FullDocumentSearchApi, kind: AIReviewScope['kind']): AIReviewScope {
  return resolveScope(api, kind);
}

/** Shared UTF-16 mapping for a remembered template bookmark, including a caret. */
export function resolveNoteMarkdownRange(api: FullDocumentSearchApi, range: { from: number; to: number }): AIReviewScope {
  return resolveScope(api, 'selection', range);
}

function resolveScope(api: FullDocumentSearchApi, kind: AIReviewScope['kind'], range?: { from: number; to: number }): AIReviewScope {
  const baseline = api.getFullDocument();
  if (kind === 'page') return { kind, from: 0, to: baseline.markdown.length, baseline };
  const crepe = api.getCrepe();
  if (!crepe) throw new Error('笔记编辑器尚未就绪。');
  return crepe.editor.action(ctx => {
    const view = ctx.get(editorViewCtx);
    const doc = api.isDocumentWindowed?.() ? ctx.get(parserCtx)(baseline.markdown) : view.state.doc;
    if (!doc) throw new Error('无法读取完整笔记。');
    const serialize = ctx.get(serializerCtx);
    const marker = `DSSCOPE${crypto.randomUUID().replace(/-/g, '')}`;
    const boundary = (pos: number, root = false, end = false) => {
      if (pos === 0) return 0;
      if (pos === doc.content.size) return baseline.markdown.length;
      const tr = EditorState.create({ doc }).tr;
      if (root) tr.insert(pos, doc.type.schema.nodes.paragraph.create(null, doc.type.schema.text(marker)));
      else {
        const resolved = doc.resolve(pos);
        const neighbor = end ? resolved.nodeBefore : resolved.nodeAfter;
        tr.insert(pos, doc.type.schema.text(marker, neighbor?.isInline ? neighbor.marks : resolved.marks()));
      }
      return sourceOffset(baseline.markdown, serialize(tr.doc), marker);
    };
    const selection = range ? { ...range, empty: range.from === range.to,
      $from: doc.resolve(range.from), $to: doc.resolve(range.to) } : view.state.selection;
    if (kind === 'selection') {
      if (selection.empty && !range) throw new Error('请先在笔记中选择文本。');
      const from = boundary(selection.from, selection.$from.depth === 0);
      const to = selection.empty ? from : boundary(selection.to, selection.$to.depth === 0, true);
      if (to < from || (to === from && !selection.empty)) throw new Error('无法精确定位所选范围。');
      return { kind, from, to, baseline };
    }
    const roots: Array<{ pos: number; end: number; heading: number | null }> = [];
    doc.forEach((node, pos) => roots.push({ pos, end: pos + node.nodeSize,
      heading: node.type.name === 'heading' ? Number(node.attrs.level) : null }));
    let index = roots.findIndex(root => selection.from >= root.pos && selection.from < root.end);
    if (index < 0) index = roots.length - 1;
    let end = index + 1;
    if (kind === 'section') {
      while (index > 0 && roots[index].heading === null) index--;
      const level = roots[index]?.heading;
      end = index + 1;
      while (end < roots.length && (roots[end].heading === null || (level !== null && roots[end].heading! > level))) end++;
    }
    return { kind, from: boundary(roots[index]?.pos ?? 0, true),
      to: boundary(roots[end]?.pos ?? doc.content.size, true), baseline };
  });
}

export interface ReviewSaveAsResponse { noteId: string; revision: number; markdown: string; updatedAt: string }
/** Backend owns operation idempotency and CAS; no create-note fallback. */
export async function saveReviewAs(markdown: string, operationId: string, sourceNoteId: string,
  _title: string, baseline?: FullDocumentSnapshot, lease?: NoteLeaseAuth): Promise<ReviewSaveAsResponse> {
  // Keep the opaque storage token with savedAs in the persisted review session.
  // Reading a newer token on recovery could silently approve an external edit.
  const expectedUpdatedAt = (baseline as Partial<ReviewSaveAsResponse> | undefined)?.updatedAt;
  if (baseline && !expectedUpdatedAt) throw new Error('审阅副本缺少原保存版本，请重新审阅后另存。');
  const result = await invoke<ReviewSaveAsResponse>('notes_review_save_as', {
    operationId, sourceNoteId, markdown,
    expectedUpdatedAt: expectedUpdatedAt ?? null, capabilities: ['ds-columns-v1'],
    ...(lease ? { lease } : {}),
  });
  if (!result?.noteId || !Number.isInteger(result.revision) || typeof result.markdown !== 'string' || !result.updatedAt) throw new Error('另存笔记未得到持久化确认。');
  return result;
}
