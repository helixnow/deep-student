/**
 * Toggle 块 remark 插件：把 Obsidian 折叠 callout 形状的 blockquote
 * 转成自定义 MDAST `toggle`，供 Milkdown parseMarkdown 消费。
 *
 * CommonMark 会把
 *   > [!toggle]- 标题
 *   > 正文
 * 收成「同一 paragraph + softbreak」，因此必须按首行拆 marker，剩余行留作内容。
 */

import type { Node } from '@milkdown/transformer'
import { $remark } from '@milkdown/utils'
import { visit } from 'unist-util-visit'

import { parseToggleMarker, TOGGLE_TYPE, type ToggleMarker } from './marker'

type MdastParent = Node & { children: Node[] }

function isParent(node: Node): node is MdastParent {
  return Array.isArray((node as MdastParent).children)
}

function collectPlainText(node: Node): string {
  if (node.type === 'text') {
    return String((node as Node & { value?: string }).value ?? '')
  }
  // mdast softbreak / break → 换行，便于按行拆 marker
  if (node.type === 'break' || node.type === 'softbreak') {
    return '\n'
  }
  if (!isParent(node)) {
    return String((node as Node & { value?: string }).value ?? '')
  }
  return node.children.map(collectPlainText).join('')
}

function emptyParagraph(): Node {
  return { type: 'paragraph', children: [] } as Node
}

/**
 * 从 blockquote 首段拆出 toggle marker；若首段含 softbreak 后的正文，生成剩余 paragraph。
 */
function extractMarkerFromBlockquote(
  blockquote: MdastParent,
): { marker: ToggleMarker; body: Node[] } | null {
  if (blockquote.children.length === 0) return null
  const first = blockquote.children[0]
  if (!first || first.type !== 'paragraph' || !isParent(first)) return null

  const fullText = collectPlainText(first)
  const lines = fullText.split('\n')
  const firstLine = lines[0] ?? ''
  const marker = parseToggleMarker(firstLine)
  if (!marker) return null

  const restLines = lines.slice(1).join('\n').replace(/^\n/, '')
  const restSiblings = blockquote.children.slice(1)
  const body: Node[] = []

  if (restLines.trim().length > 0) {
    body.push({
      type: 'paragraph',
      children: [{ type: 'text', value: restLines } as Node],
    } as Node)
  }
  body.push(...restSiblings)

  if (body.length === 0) {
    body.push(emptyParagraph())
  }

  return { marker, body }
}

function transformToggleBlockquotes() {
  return (tree: Node) => {
    visit(tree, 'blockquote', (node: Node, index: number | undefined, parent: Node | undefined) => {
      if (index == null || !parent || !isParent(parent) || !isParent(node)) return

      const extracted = extractMarkerFromBlockquote(node)
      if (!extracted) return

      const toggleNode: Node & {
        type: string
        open: boolean
        title: string
        children: Node[]
      } = {
        type: TOGGLE_TYPE,
        open: extracted.marker.open,
        title: extracted.marker.title,
        children: extracted.body,
      }

      parent.children.splice(index, 1, toggleNode)
    })
  }
}

export const remarkTogglePlugin = $remark('remark-toggle', () => transformToggleBlockquotes)
