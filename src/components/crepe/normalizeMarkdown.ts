import type { Ctx } from '@milkdown/ctx';
import { editorViewCtx, schemaCtx, remarkCtx } from '@milkdown/kit/core';
import { ParserState, SerializerState } from '@milkdown/transformer';
import { EditorState } from '@milkdown/prose/state';
import type { Node } from '@milkdown/prose/model';
import { trailingConfig } from '@milkdown/kit/plugin/trailing';
import { normalizeOfficialDiffDoc, withoutTrailingPlaceholderParagraph } from './officialDiffAdapter';

// Source positions and list looseness describe spelling/layout, not document content.
// Compare every other property, including unknown extension attributes, without hashing.
function sameMarkdownTree(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((entry, index) => sameMarkdownTree(entry, right[index]));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  // PM fills empty list items / blockquotes with a paragraph (built-in templates
  // contain `- ` and `> `); its serializer emits the empty paragraph placeholder.
  const children = (node: Record<string, unknown>, key: string) =>
    key === 'children' && (node.type === 'listItem' || node.type === 'blockquote') && Array.isArray(node.children) && node.children.length === 0
      ? [{ type: 'paragraph', children: [] }] : node[key];
  const keys = (value: Record<string, unknown>) => Object.keys(value)
    .filter((key) => key !== 'position' && !(key === 'spread' && (value.type === 'list' || value.type === 'listItem')));
  const aKeys = keys(a), bKeys = keys(b);
  return aKeys.length === bKeys.length && aKeys.every((key) => bKeys.includes(key) && sameMarkdownTree(children(a, key), children(b, key)));
}

/** Crepe's trailing plugin owns the final empty paragraph: the serializer may
 * drop the placeholder an earlier round emitted as `<br />`. It carries no user
 * content, so the preflight compares the document without that placeholder. */
function withoutTrailingEmptyParagraph<T>(node: T): T {
  const children = (node as { children?: unknown })?.children;
  if (!Array.isArray(children) || children.length === 0) return node;
  const last = children[children.length - 1] as { type?: unknown; children?: unknown } | undefined;
  if (last?.type !== 'paragraph' || !Array.isArray(last.children) || last.children.length > 0) return node;
  return { ...(node as object), children: children.slice(0, -1) } as T;
}

/** Pure preflight using the mounted editor's schema/plugins. Never dispatches a transaction. */
export function normalizeMarkdown(ctx: Ctx, markdown: string): string {
  const schema = ctx.get(schemaCtx);
  const remark = ctx.get(remarkCtx);
  // Same engine as parserCtx/serializerCtx, with fresh stacks: a throwing schema
  // runner must not poison the mounted editor's reusable parser/serializer state.
  const parse = ParserState.create(schema, remark);
  const serialize = (doc: Node) => {
    // Milkdown's empty-paragraph serializer consults view.state.doc.lastChild by
    // identity. Give it the projected document for this synchronous call only;
    // never update/dispatch to the live view (which would cancel uploads/change history).
    const view = ctx.get(editorViewCtx);
    const projection = Object.create(view) as typeof view;
    Object.defineProperty(projection, 'state', { value: EditorState.create({ doc }) });
    ctx.set(editorViewCtx, projection);
    try { return SerializerState.create(schema, remark)(doc); }
    finally { ctx.set(editorViewCtx, view); }
  };
  const raw = parse(markdown);
  if (!raw) throw new Error('Markdown parsing failed.');
  const parsed = normalizeOfficialDiffDoc(raw);
  parsed.check();
  const canonical = serialize(parsed);
  const tree = (source: string) => remark.runSync(remark.parse(source), source);
  // Comparing PM documents alone would miss nodes already dropped by the schema parser.
  if (!sameMarkdownTree(
    withoutTrailingEmptyParagraph(tree(markdown)),
    withoutTrailingEmptyParagraph(tree(canonical)),
  )) {
    throw new Error('Markdown normalization would change or lose content unsupported by the editor schema.');
  }
  const reparsedRaw = parse(canonical);
  const reparsed = reparsedRaw && normalizeOfficialDiffDoc(reparsedRaw);
  if (!reparsed
    || !withoutTrailingPlaceholderParagraph(parsed).eq(withoutTrailingPlaceholderParagraph(reparsed))) {
    throw new Error('Markdown schema round-trip changed the document.');
  }
  // Crepe's trailing plugin adds an empty paragraph after lists/code/other blocks.
  // Model that documented transaction without dispatching or touching upload/history state.
  const trailing = ctx.get(trailingConfig.key);
  const state = EditorState.create({ doc: parsed });
  if (!trailing.shouldAppend(parsed.lastChild, state)) return canonical;
  const trailingNode = trailing.getNode(state);
  if (trailingNode.type.name !== 'paragraph' || trailingNode.content.size !== 0) {
    throw new Error('Unsupported trailing node normalization.');
  }
  return serialize(state.tr.insert(parsed.content.size, trailingNode).doc);
}
