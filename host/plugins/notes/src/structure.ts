// note_structure.rs: root Markdown spans shared by format validation and history slicing.
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { invalid } from '../repository/errors.ts';
import { rustTrim } from '../../../platform/util/index.ts';

export interface RootSpan {
  start: number;
  end: number;
  paragraph: boolean;
  columns: boolean;
}

interface PositionedNode {
  type: string;
  position?: { start: { offset?: number; line: number; column: number }; end: { offset?: number; line: number; column: number } };
}

/** Byte offsets are only needed for link positions; roots use JS offsets for slicing. */
function offsetOf(content: string, offset: number | undefined, line: number, column: number): number {
  if (offset !== undefined) return offset;
  let currentLine = 1;
  let index = 0;
  while (currentLine < line && index < content.length) {
    if (content.charCodeAt(index) === 10) currentLine += 1;
    index += 1;
  }
  return index + column - 1;
}

function trimmedEnds(content: string, start: number, end: number): string {
  return content.slice(start, end).replace(/[\n\r]+$/, '');
}

/** pulldown-cmark root ranges include the newline that terminates the block. */
function includeTrailingNewline(content: string, end: number): number {
  if (content[end] === '\n') return end + 1;
  if (content[end] === '\r' && content[end + 1] === '\n') return end + 2;
  return end;
}

function delimiter(root: RootSpan, content: string): string | null {
  const text = trimmedEnds(content, root.start, root.end);
  return root.paragraph && !text.includes('\n') && text.startsWith(':::') ? text : null;
}

function reserved(text: string): boolean {
  return text.startsWith(':::ds-columns')
    || text.startsWith(':::column')
    || text.startsWith(':::end-column')
    || text.startsWith(':::end-ds-columns');
}

function markdownRoots(content: string): RootSpan[] {
  const tree = fromMarkdown(content, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as unknown as { children: PositionedNode[] };
  const roots: RootSpan[] = [];
  for (const node of tree.children) {
    // pulldown-cmark consumes reference definitions instead of emitting a root node.
    if (node.type === 'definition') continue;
    if (!node.position) continue;
    const start = offsetOf(content, node.position.start.offset, node.position.start.line, node.position.start.column);
    const end = includeTrailingNewline(content,
      offsetOf(content, node.position.end.offset, node.position.end.line, node.position.end.column));
    roots.push({ start, end, paragraph: node.type === 'paragraph', columns: false });
  }
  return roots;
}

export function roots(content: string): RootSpan[] {
  const raw = markdownRoots(content);
  const result: RootSpan[] = [];
  let index = 0;
  while (index < raw.length) {
    const token = delimiter(raw[index]!, content);
    if (token !== null && token.startsWith(':::ds-columns')) {
      if (token !== ':::ds-columns{version=1 layout=equal}' && token !== ':::ds-columns{version=1 layout=cornell}') {
        invalid('Unsupported ds-columns version or layout');
      }
      const start = raw[index]!.start;
      index += 1;
      for (let column = 0; column < 2; column += 1) {
        const columnToken = raw[index];
        if (columnToken === undefined || delimiter(columnToken, content) !== ':::column') {
          invalid('Columns must contain exactly two columns');
        }
        index += 1;
        for (;;) {
          const root = raw[index];
          if (root === undefined) invalid('Unclosed ds-columns container');
          const current = delimiter(root, content);
          if (current === ':::end-column') {
            index += 1;
            break;
          }
          if (current !== null && reserved(current)) invalid('Nested or malformed column delimiter');
          index += 1;
        }
      }
      const endToken = raw[index];
      if (endToken === undefined || delimiter(endToken, content) !== ':::end-ds-columns') {
        invalid('Missing ds-columns end or extra column');
      }
      result.push({ start, end: includeTrailingNewline(content, endToken.end), paragraph: false, columns: true });
      index += 1;
    } else {
      if (token !== null && reserved(token)) invalid('Column delimiter outside a container');
      result.push({ ...raw[index]! });
      index += 1;
    }
  }
  return result;
}

export interface StableBlock {
  id: string;
  body: string;
}

export function marker(text: string): string | null {
  const trimmed = text.replace(/[\n\r]+$/, '');
  if (!trimmed.startsWith('<!-- ds:block-id=') || !trimmed.endsWith(' -->')) return null;
  const id = trimmed.slice('<!-- ds:block-id='.length, trimmed.length - ' -->'.length);
  if (id.length === 0 || id.length > 128 || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return id;
}

export function blocks(content: string): StableBlock[] {
  const ranges = roots(content);
  const ids = new Set<string>();
  const result: StableBlock[] = [];
  let pending: string | null = null;
  let covered = 0;
  for (const root of ranges) {
    if (rustTrim(content.slice(covered, root.start)).length > 0) invalid('Unmarked Markdown content');
    const text = content.slice(root.start, root.end);
    const id = marker(text);
    if (id !== null) {
      if (pending !== null || ids.has(id)) invalid('Duplicate or consecutive block marker');
      ids.add(id);
      pending = id;
    } else {
      if (pending === null) invalid('Every root Markdown node requires a block marker');
      result.push({ id: pending as string, body: text.replace(/[\n\r]+$/, '') });
      pending = null;
    }
    covered = root.end;
  }
  if (pending !== null || rustTrim(content.slice(covered)).length > 0) invalid('Incomplete block document');
  return result;
}
