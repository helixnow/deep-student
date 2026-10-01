import { invoke } from '@tauri-apps/api/core';
import type { Ctx } from '@milkdown/ctx';
import { remarkCtx } from '@milkdown/kit/core';
import { normalizeMarkdown } from '../normalizeMarkdown';
import { readBlockMarker, blockMarker, newBlockId } from '../plugins/blockIdentity/markdown';
import { parseColumnsTree } from '../plugins/columns/remark';
import type { MarkdownNode } from '@milkdown/transformer';

export interface BlockTransferNote { id: string; title: string; path: string }
export interface BlockTransferSnapshot { noteId: string; content: string; updatedAt: string }
export interface BlockTransferRequest {
  operation_id: string;
  source_note_id: string;
  target_note_id: string;
  expected_source_updated_at: string;
  expected_target_updated_at: string;
  source_content: string;
  target_content: string;
  block_ids: string[];
}
export interface BlockTransferResult {
  operation_id: string;
  source_updated_at: string;
  target_updated_at: string;
  source_note_id: string;
  target_note_id: string;
  source_version_id: string;
  target_version_id: string;
  undone: boolean;
}
export interface BlockTransferReceipt {
  sourceNoteId: string;
  targetNoteId: string;
  result: BlockTransferResult;
  /** The backend committed. A refresh failure must never be presented as a failed move. */
  refreshError?: unknown;
}
export interface BlockTransferHost {
  listNotes(): Promise<BlockTransferNote[]>;
  /** Lock both note editing/autosave lifecycles until task finishes (including refresh).
   * Must cover every open draft for these IDs, not only the current editor. */
  withLockedNotes<T>(noteIds: readonly string[], task: () => Promise<T>): Promise<T>;
  flushPendingSaves(noteIds: readonly string[]): Promise<void>;
  /** Read complete authoritative snapshots after flush, including saved updated_at. */
  readNote(noteId: string): Promise<BlockTransferSnapshot>;
  /** After a commit, cancel stale save tokens and keep affected open drafts blocked
   * until refresh installs the new baselines (also when refresh fails). */
  invalidateNotes(noteIds: readonly string[]): void;
  /** Reload both notes, update save baselines and clear local undo of pre-transfer content. */
  refreshNotes(noteIds: readonly string[]): Promise<void>;
}
interface MarkdownRoot {
  children: { type: string; value?: string; position?: { start: { offset?: number }; end: { offset?: number } } }[];
}
const isEmptyParagraphHtml = (node: MarkdownRoot['children'][number]) =>
  node.type === 'html' && /^<br\s*\/?\s*>$/.test(node.value?.trim() ?? '');
export interface BlockTransferCodec {
  preflight(markdown: string): string;
  parse(markdown: string): MarkdownRoot;
}
export function createBlockTransferCodec(ctx: Ctx): BlockTransferCodec {
  return {
    preflight(markdown) { return normalizeMarkdown(ctx, markdown); },
    parse(markdown) {
      const tree = ctx.get(remarkCtx).parse(markdown);
      parseColumnsTree(tree as unknown as MarkdownNode, markdown);
      return tree as MarkdownRoot;
    },
  };
}

/** Explicit format upgrade: insert ONLY marker lines into the original Markdown.
 * Removing those lines reproduces the legacy source byte-for-byte, as required
 * by notes_migrate_blocks. Opening a document never calls this function. */
export function planBlockIdentityUpgrade(markdown: string, codec: BlockTransferCodec) {
  codec.preflight(markdown);
  const children = codec.parse(markdown).children;
  const ids: string[] = [];
  const inserts: { at: number; text: string }[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < children.length; index++) {
    const node = children[index];
    const existing = node.type === 'html' ? readBlockMarker(node.value) : null;
    if (existing) {
      if (seen.has(existing)) throw new Error(`Duplicate block ID: ${existing}`);
      const next = children[++index];
      if (!next || (next.type === 'html' && !isEmptyParagraphHtml(next)) || next.type === 'definition') throw new Error('Unsupported block identity target.');
      seen.add(existing); ids.push(existing);
      continue;
    }
    // Raw HTML/reference definitions are not safe upgrade targets for the v1 schema pair.
    if ((node.type === 'html' && !isEmptyParagraphHtml(node)) || node.type === 'definition') throw new Error('This note contains root syntax unsupported by stable blocks.');
    const offset = node.position?.start.offset;
    if (offset == null) throw new Error('Missing root block source position.');
    const at = markdown.lastIndexOf('\n', offset - 1) + 1;
    const id = newBlockId(); ids.push(id);
    inserts.push({ at, text: blockMarker(id) + (markdown.includes('\r\n') ? '\r\n' : '\n') });
  }
  let content = markdown;
  for (const insert of inserts.reverse()) content = content.slice(0, insert.at) + insert.text + content.slice(insert.at);
  codec.preflight(content);
  return { content, blockIds: ids };
}

function blocks(markdown: string, codec: BlockTransferCodec) {
  codec.preflight(markdown);
  const children = codec.parse(markdown).children;
  const result = new Map<string, { from: number; to: number }>();
  children.forEach((node, index) => {
    const id = node.type === 'html' ? readBlockMarker(node.value) : null;
    if (!id) return;
    const next = children[index + 1];
    const from = node.position?.start.offset, to = next?.position?.end.offset;
    if (result.has(id)) throw new Error(`Duplicate block ID: ${id}`);
    if (!next || (next.type === 'html' && !isEmptyParagraphHtml(next)) || next.type === 'definition' || from == null || to == null) {
      throw new Error('Invalid block identity span.');
    }
    result.set(id, { from, to });
  });
  return result;
}

/** Splice original Markdown spans; unselected source/target spelling is preserved. */
export function planBlockTransfer(source: string, target: string, ids: readonly string[], codec: BlockTransferCodec) {
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error('Select distinct blocks to move.');
  const sourceBlocks = blocks(source, codec), targetBlocks = blocks(target, codec);
  // Imported collisions anywhere in the pair are rejected, never silently re-keyed.
  for (const id of sourceBlocks.keys()) if (targetBlocks.has(id)) throw new Error(`Block ID collision: ${id}`);
  const spans = ids.map(id => {
    const span = sourceBlocks.get(id);
    if (!span) throw new Error(`Block no longer exists: ${id}`);
    return span;
  }).sort((a, b) => a.from - b.from);
  let sourceContent = source;
  for (const span of [...spans].reverse()) sourceContent = sourceContent.slice(0, span.from) + sourceContent.slice(span.to);
  const moved = spans.map(span => source.slice(span.from, span.to)).join('\n\n');
  const targetContent = target + (target && !target.endsWith('\n\n') ? (target.endsWith('\n') ? '\n' : '\n\n') : '') + moved + '\n';
  codec.preflight(sourceContent);
  codec.preflight(targetContent);
  return { sourceContent, targetContent };
}

export type BlockTransferInvoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;
export function createBlockTransferService(host: BlockTransferHost, codec: BlockTransferCodec,
  call: BlockTransferInvoke = invoke) {
  const pendingRequests = new Map<string, BlockTransferRequest>();
  const stableSnapshot = async (snapshot: BlockTransferSnapshot) => {
    const format = await call<{ content_format: string; format_version: number; serializer_version: string }>('notes_get_format', { noteId: snapshot.noteId });
    const serializer = format.content_format === 'markdown-blocks' ? 'blocks-v1' : 'markdown-v1';
    if (format.format_version !== 1 || !['markdown-legacy', 'markdown-blocks'].includes(format.content_format)
      || ![serializer, `${serializer}+ds-columns-v1`].includes(format.serializer_version)) {
      throw new Error('Unsupported note format.');
    }
    const plan = planBlockIdentityUpgrade(snapshot.content, codec);
    if (format.content_format === 'markdown-blocks') {
      if (plan.content !== snapshot.content) throw new Error('Stable note contains unmarked blocks.');
      return { snapshot, blockIds: plan.blockIds };
    }
    await call('notes_migrate_blocks', { noteId: snapshot.noteId, expectedUpdatedAt: snapshot.updatedAt, content: plan.content });
    // A later move may fail. Still reconcile the successful format upgrade while
    // holding the draft lock, so a stale autosave cannot write the legacy body back.
    host.invalidateNotes([snapshot.noteId]);
    await host.refreshNotes([snapshot.noteId]);
    return { snapshot: await host.readNote(snapshot.noteId), blockIds: plan.blockIds };
  };
  const refresh = async (receipt: BlockTransferReceipt) => {
    host.invalidateNotes([receipt.sourceNoteId, receipt.targetNoteId]);
    try { await host.refreshNotes([receipt.sourceNoteId, receipt.targetNoteId]); }
    catch (error) { receipt.refreshError = error; }
    return receipt;
  };
  return {
    listTargets: (sourceNoteId: string) => host.listNotes().then(notes => notes.filter(note => note.id !== sourceNoteId)),
    async ensureIdentities(noteId: string, expectedMarkdown: string) {
      return host.withLockedNotes([noteId], async () => {
        await host.flushPendingSaves([noteId]);
        const snapshot = await host.readNote(noteId);
        if (codec.preflight(snapshot.content) !== codec.preflight(expectedMarkdown)) throw new Error('Note changed before identity upgrade. Select the blocks again.');
        const result = await stableSnapshot(snapshot);
        return result.blockIds;
      });
    },
    async move(sourceNoteId: string, targetNoteId: string, blockIds: readonly string[], operationId = crypto.randomUUID()) {
      if (sourceNoteId === targetNoteId) throw new Error('Choose a different target note.');
      const noteIds = [sourceNoteId, targetNoteId];
      return host.withLockedNotes(noteIds, async () => {
        await host.flushPendingSaves(noteIds);
        const retry = pendingRequests.get(operationId);
        if (retry) {
          if (retry.source_note_id !== sourceNoteId || retry.target_note_id !== targetNoteId
            || retry.block_ids.length !== blockIds.length || retry.block_ids.some((id, index) => id !== blockIds[index])) {
            throw new Error('Operation ID reused for a different move.');
          }
          const result = await call<BlockTransferResult>('notes_transfer_blocks', { request: retry });
          pendingRequests.delete(operationId);
          return refresh({ sourceNoteId, targetNoteId, result });
        }
        let [source, target] = await Promise.all(noteIds.map(id => host.readNote(id)));
        if (source.noteId !== sourceNoteId || target.noteId !== targetNoteId) throw new Error('Note identity changed.');
        // Validate both complete drafts before upgrading either page.
        codec.preflight(source.content); codec.preflight(target.content);
        source = (await stableSnapshot(source)).snapshot;
        target = (await stableSnapshot(target)).snapshot;
        const plan = planBlockTransfer(source.content, target.content, blockIds, codec);
        const request: BlockTransferRequest = {
          operation_id: operationId, source_note_id: sourceNoteId, target_note_id: targetNoteId,
          expected_source_updated_at: source.updatedAt, expected_target_updated_at: target.updatedAt,
          source_content: plan.sourceContent, target_content: plan.targetContent, block_ids: [...blockIds],
        };
        pendingRequests.set(operationId, request);
        const result = await call<BlockTransferResult>('notes_transfer_blocks', { request });
        pendingRequests.delete(operationId);
        return refresh({ sourceNoteId, targetNoteId, result });
      });
    },
    async undo(receipt: BlockTransferReceipt) {
      const noteIds = [receipt.sourceNoteId, receipt.targetNoteId];
      return host.withLockedNotes(noteIds, async () => {
        await host.flushPendingSaves(noteIds);
        // Keep the committed revisions as preconditions: later edits must cause conflict.
        const result = await call<BlockTransferResult>('notes_undo_transfer', {
          operationId: receipt.result.operation_id,
          expectedSourceUpdatedAt: receipt.result.source_updated_at,
          expectedTargetUpdatedAt: receipt.result.target_updated_at,
        });
        return refresh({ sourceNoteId: receipt.sourceNoteId, targetNoteId: receipt.targetNoteId, result });
      });
    },
  };
}
export type BlockTransferService = ReturnType<typeof createBlockTransferService>;
