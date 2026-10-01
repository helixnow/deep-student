import { $remark } from '@milkdown/utils'
import type { Processor } from 'unified'
import type { Options, Handle } from 'mdast-util-to-markdown'
import type { MarkdownNode } from '@milkdown/transformer'
import type { Root } from 'mdast'
import {
  COLUMNS_TYPE, COLUMN_TYPE, COLUMN_OPEN, COLUMN_CLOSE, COLUMNS_CLOSE,
  columnsOpen, parseColumnsOpen, type ColumnsLayout,
} from './format'

declare module 'mdast-util-to-markdown' {
  interface ConstructNameMap { dsColumns: 'dsColumns'; dsColumn: 'dsColumn' }
}

/** Delimiters must be standalone, unescaped paragraphs at the document root.
 * Reading the original spelling avoids interpreting escaped literal text as layout.
 * Code, HTML, blockquotes and list contents never participate in the grammar.
 */
function marker(node: MarkdownNode | undefined, source: string): string | null {
  if (!node || node.type !== 'paragraph' || node.children?.length !== 1 || node.children[0].type !== 'text') return null
  const value = String(node.children[0].value ?? '')
  const start = node.position?.start.offset, end = node.position?.end.offset
  if (start == null || end == null || source.slice(start, end) !== value) return null
  return value.startsWith(':::') && !value.includes('\n') ? value : null
}

export function parseColumnsTree(tree: MarkdownNode, source: string): void {
  if (tree.type !== 'root' || !tree.children) return
  const nodes = tree.children
  const result: MarkdownNode[] = []
  for (let i = 0; i < nodes.length; i++) {
    const startMarker = marker(nodes[i], source)
    if (!startMarker?.startsWith(':::ds-columns')) { result.push(nodes[i]); continue }
    // Consume the entire attempted container before deciding. An invalid outer
    // container must not cause a valid inner one to be silently upgraded.
    let depth = 1, end = i + 1
    for (; end < nodes.length; end++) {
      const text = marker(nodes[end], source)
      if (text?.startsWith(':::ds-columns')) depth++
      if (text === COLUMNS_CLOSE && --depth === 0) break
    }
    if (end === nodes.length) { result.push(...nodes.slice(i)); break }
    const layout = parseColumnsOpen(startMarker)
    const columns: MarkdownNode[] = []
    let cursor = i + 1
    if (layout) {
      for (let col = 0; col < 2; col++) {
        if (marker(nodes[cursor], source) !== COLUMN_OPEN) break
        const begin = ++cursor
        while (cursor < end && marker(nodes[cursor], source) !== COLUMN_CLOSE) {
          const text = marker(nodes[cursor], source)
          if (text === COLUMN_OPEN || text?.startsWith(':::ds-columns') || text === COLUMNS_CLOSE) break
          cursor++
        }
        if (cursor >= end || marker(nodes[cursor], source) !== COLUMN_CLOSE) break
        columns.push({ type: COLUMN_TYPE, children: cursor === begin
          ? [{ type: 'paragraph', children: [] }] : nodes.slice(begin, cursor) })
        cursor++
      }
    }
    if (layout && columns.length === 2 && cursor === end) {
      result.push({ type: COLUMNS_TYPE, layout, children: columns,
        position: nodes[i].position && nodes[end].position ? {
          start: nodes[i].position!.start, end: nodes[end].position!.end,
        } : undefined,
      })
    } else result.push(...nodes.slice(i, end + 1))
    i = end
  }
  tree.children = result
}

// The same remark processor serializes the child AST, retaining existing GFM,
// math, callout, toggle, wikilink and future registered handlers.
const columnsHandler: Handle = (node, _parent, state, info) => {
  const layout = (node as unknown as MarkdownNode).layout as ColumnsLayout
  const exit = state.enter('dsColumns')
  const body = state.containerFlow(node as Parameters<typeof state.containerFlow>[0], info)
  exit()
  return `${columnsOpen(layout)}\n\n${body}\n\n${COLUMNS_CLOSE}`
}
const columnHandler: Handle = (node, _parent, state, info) => {
  const exit = state.enter('dsColumn')
  const body = state.containerFlow(node as Parameters<typeof state.containerFlow>[0], info)
  exit()
  return `${COLUMN_OPEN}\n\n${body}${body ? '\n\n' : ''}${COLUMN_CLOSE}`
}

export function remarkColumns(this: Processor) {
  const data = this.data() as { toMarkdownExtensions?: Options[] }
  ;(data.toMarkdownExtensions ??= []).push({
    // Runtime extension nodes are consumed by our Milkdown schema; they are not
    // added globally to mdast's standard BlockContent union.
    handlers: { [COLUMNS_TYPE]: columnsHandler, [COLUMN_TYPE]: columnHandler } as Options['handlers'],
    // User text resembling a delimiter stays text on the next parse. Real
    // delimiters are emitted only by the two custom handlers above.
    unsafe: [{ character: ':', atBreak: true, after: '::' }],
  })
  return (tree: Root, file: { toString(): string }) => parseColumnsTree(tree as unknown as MarkdownNode, file.toString())
}

export const remarkColumnsPlugin = $remark('remark-ds-columns', () => remarkColumns)
