import type { EditorView } from '@milkdown/prose/view';
import { Selection } from '@milkdown/prose/state';
import { BLOCK_ID_ATTR, BLOCK_ID_PATTERN, readBlockMarker } from './markdown';

export interface BlockLinkTarget { noteId: string; blockId: string }
export const BLOCK_LINK_OPEN_EVENT = 'notes:block-link-open';
export function buildBlockLink({ noteId, blockId }: BlockLinkTarget): string {
  if (!noteId || !BLOCK_ID_PATTERN.test(blockId)) throw new Error('Invalid block link.');
  return `ds-block://note/${encodeURIComponent(noteId)}#${blockId}`;
}
export function parseBlockLink(href: string): BlockLinkTarget | null {
  const match = /^ds-block:\/\/note\/([^/#?]+)#([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/.exec(href);
  if (!match) return null;
  try { return { noteId: decodeURIComponent(match[1]), blockId: match[2] }; }
  catch { return null; }
}
export function handleBlockLinkClick(_view: EditorView, event: MouseEvent): boolean {
  if (event.button !== 0 || !(event.target instanceof Element)) return false;
  const target = parseBlockLink(event.target.closest('a[href]')?.getAttribute('href') ?? '');
  if (!target) return false;
  event.preventDefault();
  event.stopPropagation();
  window.dispatchEvent(new CustomEvent<BlockLinkTarget>(BLOCK_LINK_OPEN_EVENT, { detail: target }));
  return true;
}
export function focusBlockId(view: EditorView, id: string): boolean {
  let found: number | null = null;
  view.state.doc.forEach((node, pos) => { if (node.attrs[BLOCK_ID_ATTR] === id) found = pos; });
  if (found === null) return false;
  view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(found + 1))).scrollIntoView());
  const dom = view.nodeDOM(found);
  if (dom instanceof HTMLElement) dom.scrollIntoView?.({ block: 'center' });
  view.focus();
  return true;
}

/** Host opens/materializes the requested note and returns its live editor API. */
export function installBlockLinkBridge(host: {
  /** Resolve the Markdown owner after a cross-page move; null means deleted.
   * Use resolveBlockLinkOwner below or an equivalent authoritative backend index. */
  resolveTarget: (target: BlockLinkTarget) => Promise<BlockLinkTarget | null>;
  openNote: (noteId: string) => Promise<{ focusBlock: (id: string) => boolean | Promise<boolean> }>;
  onMissing: (target: BlockLinkTarget) => void;
  onError: (error: unknown) => void;
}): () => void {
  let ticket = 0;
  const listener = (event: Event) => {
    const target = (event as CustomEvent<BlockLinkTarget>).detail;
    const current = ++ticket;
    void host.resolveTarget(target).then(async resolved => {
      if (current !== ticket) return;
      if (!resolved) { host.onMissing(target); return; }
      const api = await host.openNote(resolved.noteId);
      if (current !== ticket) return;
      if (!await api.focusBlock(resolved.blockId)) host.onMissing(target);
    }).catch(host.onError);
  };
  window.addEventListener(BLOCK_LINK_OPEN_EVENT, listener);
  return () => { ticket++; window.removeEventListener(BLOCK_LINK_OPEN_EVENT, listener); };
}

/** Markdown remains the authority. The original note is a routing hint; after a
 * move, locate its ID in complete note Markdown. Hosts may replace the scan with
 * an index maintained by backend transactions. Never use title matching. */
export async function resolveBlockLinkOwner(target: BlockLinkTarget, source: {
  readMarkdown(noteId: string): Promise<string | null>;
  listNoteIds(): Promise<readonly string[]>;
  parse(markdown: string): { children: { type: string; value?: unknown }[] };
}): Promise<BlockLinkTarget | null> {
  const contains = async (noteId: string) => {
    const markdown = await source.readMarkdown(noteId);
    if (markdown === null) return false;
    const children = source.parse(markdown).children;
    return children.some((node, index) => node.type === 'html'
      && readBlockMarker(node.value) === target.blockId && children[index + 1]
      && !readBlockMarker(children[index + 1].value));
  };
  if (await contains(target.noteId)) return target;
  let owner: string | null = null;
  for (const noteId of new Set(await source.listNoteIds())) {
    if (noteId === target.noteId || !await contains(noteId)) continue;
    if (owner) throw new Error(`Ambiguous block ID: ${target.blockId}`);
    owner = noteId;
  }
  return owner ? { noteId: owner, blockId: target.blockId } : null;
}
