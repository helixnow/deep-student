import { Fragment, type Node, Slice } from '@milkdown/prose/model'
import { COLUMNS_TYPE, COLUMN_TYPE } from './format'

export function containsColumns(fragment: Fragment): boolean {
  let found = false
  fragment.descendants((node) => {
    if (node.type.name === COLUMNS_TYPE || node.type.name === COLUMN_TYPE) found = true
    return !found
  })
  return found
}

/** Flatten only layout wrappers, preserving every content node and its order. */
export function flattenColumns(fragment: Fragment): Fragment {
  const result: Node[] = []
  fragment.forEach((node) => {
    const children = node.isLeaf ? node.content : flattenColumns(node.content)
    if (node.type.name === COLUMNS_TYPE || node.type.name === COLUMN_TYPE) {
      children.forEach((child) => result.push(child))
    } else result.push(node.isLeaf ? node : node.copy(children))
  })
  return Fragment.from(result)
}

export function exportColumnsPlainMarkdown(doc: Node, serialize: (doc: Node) => string): string {
  return serialize(doc.copy(flattenColumns(doc.content)))
}

export function columnsClipboardMarkdown(slice: Slice, doc: Node, serialize: (doc: Node) => string): string {
  const fragment = flattenColumns(slice.content)
  // A partial selection may consist of inline nodes rather than complete blocks.
  const blocks: Node[] = []
  let inline: Node[] = []
  const flush = () => {
    if (inline.length) blocks.push(doc.type.schema.nodes.paragraph.create(null, inline))
    inline = []
  }
  fragment.forEach((node) => { if (node.isInline) inline.push(node); else { flush(); blocks.push(node) } })
  flush()
  return serialize(doc.type.create(null, blocks))
}
