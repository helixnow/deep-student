import type { MarkdownNode } from '@milkdown/transformer';
import type { Root } from 'mdast';

export const BLOCK_ID_ATTR = 'dsBlockId';
export const BLOCK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const newBlockId = () => `blk_${crypto.randomUUID()}`;
export const blockMarker = (id: string) => {
  if (!BLOCK_ID_PATTERN.test(id)) throw new Error('Invalid block ID.');
  return `<!-- ds:block-id=${id} -->`;
};
export function readBlockMarker(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^<!-- ds:block-id=([A-Za-z0-9][A-Za-z0-9_-]{0,127}) -->$/.exec(value.trim());
  return match?.[1] ?? null;
}

/** Root-only metadata. Never interpret fenced examples or nested comments as identities. */
export function remarkBlockIdentity() {
  return (root: Root) => {
    const tree = root as unknown as MarkdownNode;
    if (tree.type !== 'root' || !tree.children) return;
    const children: MarkdownNode[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < tree.children.length; index++) {
      const node = tree.children[index];
      // Commonmark's remarkHtmlTransformer wraps root HTML in a paragraph.
      // Run after other transforms so toggle/callout replacements already exist.
      const html = node.type === 'html' ? node : node.type === 'paragraph'
        && node.children?.length === 1 && node.children[0].type === 'html' ? node.children[0] : null;
      const id = html ? readBlockMarker(html.value) : null;
      if (!id) {
        if (html && String(html.value).includes('<!-- ds:block-id=')) {
          throw new Error('Malformed block identity marker.');
        }
        children.push(node);
        continue;
      }
      const next = tree.children[++index];
      if (seen.has(id)) throw new Error(`Duplicate block ID: ${id}`);
      if (!next || next.type === 'html' || next.type === 'definition'
        || (next.type === 'paragraph' && next.children?.some(child => child.type === 'html' && readBlockMarker(child.value)))) {
        throw new Error('Block identity marker must precede one supported root block.');
      }
      seen.add(id);
      children.push({ ...next, [BLOCK_ID_ATTR]: id });
    }
    tree.children = children;
  };
}
