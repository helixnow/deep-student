import { dstu, isInkFile, type DstuNode } from '@/dstu';

export const NOTEBOOK_LIST_PAGE_SIZE = 100;
export const NOTEBOOK_CARD_PAGE_SIZE = 24;

export type NotebookKind = 'ink' | 'text';
export type NotebookFilter = 'all' | NotebookKind;
export type NotebookSource = 'note' | 'file';

export interface NotebookEntry {
  node: DstuNode;
  kind: NotebookKind;
}

export function toNotebookEntry(node: DstuNode): NotebookEntry | null {
  if (/^__.*__$/.test(node.name.trim())) return null;
  if (node.type === 'note') return { node, kind: 'text' };
  if (node.type !== 'file') return null;
  const metadata = node.metadata;
  const mimeType = typeof metadata?.canonicalMime === 'string'
    ? metadata.canonicalMime
    : typeof metadata?.mimeType === 'string' ? metadata.mimeType : undefined;
  if (!isInkFile(mimeType, node.name)) return null;
  return { node, kind: 'ink' };
}

export function notebookTitle(entry: NotebookEntry): string {
  return entry.kind === 'ink' ? entry.node.name.replace(/\.dsink$/i, '') : entry.node.name;
}

export function notebookFolder(node: DstuNode): string {
  const segments = node.path.split('/').filter(Boolean);
  if (segments.at(-1) === node.id || segments.at(-1) === node.sourceId) segments.pop();
  return segments.join(' / ');
}

export function selectNotebookEntries(
  nodes: readonly DstuNode[],
  query = '',
  filter: NotebookFilter = 'all',
): NotebookEntry[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const entries = new Map<string, NotebookEntry>();
  for (const node of nodes) {
    const entry = toNotebookEntry(node);
    if (!entry || (filter !== 'all' && filter !== entry.kind)) continue;
    const searchable = `${notebookTitle(entry)} ${notebookFolder(node)}`.toLocaleLowerCase();
    if (!words.every((word) => searchable.includes(word))) continue;
    const previous = entries.get(node.id);
    if (!previous || previous.node.updatedAt <= node.updatedAt) entries.set(node.id, entry);
  }
  return [...entries.values()].sort((a, b) =>
    b.node.updatedAt - a.node.updatedAt || a.node.id.localeCompare(b.node.id),
  );
}

export class NotebookPaginationError extends Error {
  constructor() {
    super('Notebook pagination did not advance.');
    this.name = 'NotebookPaginationError';
  }
}

export async function scanNotebookSource(
  source: NotebookSource,
  onPage: (nodes: DstuNode[]) => void,
  isCancelled: () => boolean,
): Promise<void> {
  const seen = new Set<string>();
  let offset = 0;
  while (!isCancelled()) {
    const result = await dstu.list('/', {
      typeFilter: source,
      sortBy: 'updatedAt',
      sortOrder: 'desc',
      limit: NOTEBOOK_LIST_PAGE_SIZE,
      offset,
    });
    if (isCancelled()) return;
    if (!result.ok) throw result.error;
    const nodes = result.value;
    if (nodes.length === 0) return;
    if (nodes.every((node) => seen.has(node.id))) throw new NotebookPaginationError();
    nodes.forEach((node) => seen.add(node.id));
    onPage(nodes);
    offset += NOTEBOOK_LIST_PAGE_SIZE;
  }
}
