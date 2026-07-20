import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from '@milkdown/core'
import { commonmark } from '@milkdown/preset-commonmark'
import { EditorState, TextSelection } from '@milkdown/prose/state'
import { getMarkdown } from '@milkdown/utils'
import { describe, expect, it } from 'vitest'

import { applyToggleInputRule } from '../input-rule'
import {
  TOGGLE_TYPE,
  togglePlugin,
  tryExitToggleOnEnter,
  tryUnwrapEmptyToggleOnBackspace,
} from '../index'

async function createToggleEditor(markdown: string) {
  const root = document.createElement('div')
  document.body.appendChild(root)

  const editor = Editor.make()
  editor.config((ctx) => {
    ctx.set(rootCtx, root)
    ctx.set(defaultValueCtx, markdown)
  })
  editor.use(commonmark)
  editor.use(togglePlugin())
  await editor.create()

  return {
    editor,
    root,
    view: editor.ctx.get(editorViewCtx),
    destroy: async () => {
      await editor.destroy()
      root.remove()
    },
  }
}

function findTogglePos(doc: { descendants: (f: (node: { type: { name: string }; nodeSize: number }, pos: number) => void | boolean) => void }): number | null {
  let found: number | null = null
  doc.descendants((node, pos) => {
    if (node.type.name === TOGGLE_TYPE) {
      found = pos
      return false
    }
  })
  return found
}

describe('toggle interaction', () => {
  it('clicking arrow toggles open attr and persists in markdown', async () => {
    const source = `> [!toggle] 可切换
> body
`
    const { editor, root, view, destroy } = await createToggleEditor(source)
    try {
      const toggleEl = root.querySelector('.milkdown-toggle') as HTMLElement | null
      expect(toggleEl).toBeTruthy()
      expect(toggleEl!.dataset.open).toBe('true')

      const arrow = toggleEl!.querySelector('.milkdown-toggle__arrow') as HTMLButtonElement
      expect(arrow).toBeTruthy()

      arrow.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))

      const pos = findTogglePos(view.state.doc)
      expect(pos).not.toBeNull()
      const node = view.state.doc.nodeAt(pos!)
      expect(node?.attrs.open).toBe(false)
      expect(toggleEl!.dataset.open).toBe('false')

      const md = editor.action(getMarkdown())
      expect(md).toContain('[!toggle]- 可切换')

      arrow.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      const node2 = view.state.doc.nodeAt(pos!)
      expect(node2?.attrs.open).toBe(true)
      expect(editor.action(getMarkdown())).toContain('[!toggle] 可切换')
    } finally {
      await destroy()
    }
  })

  it('Enter on trailing empty block exits toggle', async () => {
    // Markdown 会折叠空行；在 PM 文档里手动追加末尾空段再测退出
    const source = `> [!toggle] 退出
> 首段
`
    const { view, destroy } = await createToggleEditor(source)
    try {
      const togglePos = findTogglePos(view.state.doc)
      expect(togglePos).not.toBeNull()
      const toggle = view.state.doc.nodeAt(togglePos!)
      expect(toggle).toBeTruthy()

      const paragraph = view.state.schema.nodes.paragraph
      expect(paragraph).toBeTruthy()
      const empty = paragraph!.create()
      const insertAt = togglePos! + toggle!.nodeSize - 1
      view.dispatch(view.state.tr.insert(insertAt, empty))

      const toggled = view.state.doc.nodeAt(togglePos!)
      expect(toggled!.childCount).toBeGreaterThanOrEqual(2)

      const lastIndex = toggled!.childCount - 1
      let offset = togglePos! + 1
      for (let i = 0; i < lastIndex; i += 1) {
        offset += toggled!.child(i).nodeSize
      }
      const emptyPos = offset + 1
      view.dispatch(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, emptyPos)),
      )

      const childCountBefore = toggled!.childCount
      const handled = tryExitToggleOnEnter(view)
      expect(handled).toBe(true)

      const after = view.state.doc.nodeAt(togglePos!)
      expect(after?.type.name).toBe(TOGGLE_TYPE)
      expect(after!.childCount).toBe(childCountBefore - 1)

      const { $from } = view.state.selection
      let insideToggle = false
      for (let d = $from.depth; d > 0; d -= 1) {
        if ($from.node(d).type.name === TOGGLE_TYPE) insideToggle = true
      }
      expect(insideToggle).toBe(false)
    } finally {
      await destroy()
    }
  })

  it('applies open/closed CSS dataset for transition hooks', async () => {
    const { root, destroy } = await createToggleEditor(`> [!toggle]- 折叠
> x
`)
    try {
      const el = root.querySelector('.milkdown-toggle') as HTMLElement
      expect(el.dataset.open).toBe('false')
      expect(el.querySelector('.milkdown-toggle__body')).toBeTruthy()
      expect(document.getElementById('milkdown-toggle-styles')).toBeTruthy()
    } finally {
      await destroy()
    }
  })

  it('Backspace in the only empty block unwraps the toggle keeping the title', async () => {
    const source = `> [!toggle] 标题在
> 正文
`
    const { view, destroy } = await createToggleEditor(source)
    try {
      const togglePos = findTogglePos(view.state.doc)
      expect(togglePos).not.toBeNull()

      // 清空内容区，只留一个空段落
      const toggle = view.state.doc.nodeAt(togglePos!)
      const contentFrom = togglePos! + 1
      const contentTo = togglePos! + toggle!.nodeSize - 1
      const paragraph = view.state.schema.nodes.paragraph!
      view.dispatch(
        view.state.tr.replaceWith(contentFrom, contentTo, paragraph.create()),
      )
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, togglePos! + 2),
        ),
      )

      const handled = tryUnwrapEmptyToggleOnBackspace(view)
      expect(handled).toBe(true)

      const first = view.state.doc.nodeAt(togglePos!)
      expect(first?.type.name).toBe('paragraph')
      expect(first?.textContent).toBe('标题在')
    } finally {
      await destroy()
    }
  })

  it('Backspace is a no-op when the toggle still has content', async () => {
    const source = `> [!toggle] 有货
> 正文
`
    const { view, destroy } = await createToggleEditor(source)
    try {
      const togglePos = findTogglePos(view.state.doc)
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, togglePos! + 2),
        ),
      )
      expect(tryUnwrapEmptyToggleOnBackspace(view)).toBe(false)
      expect(view.state.doc.nodeAt(togglePos!)?.type.name).toBe(TOGGLE_TYPE)
    } finally {
      await destroy()
    }
  })

  it('marks empty toggles with data-empty for the placeholder hint', async () => {
    const { root, view, destroy } = await createToggleEditor(`> [!toggle] 空的
>
`)
    try {
      const el = root.querySelector('.milkdown-toggle') as HTMLElement
      expect(el.dataset.empty).toBe('true')
      const inner = el.querySelector('.milkdown-toggle__body-inner') as HTMLElement
      expect(inner.dataset.emptyPlaceholder).toBeTruthy()

      const togglePos = findTogglePos(view.state.doc)
      view.dispatch(view.state.tr.insertText('内容', togglePos! + 2))
      expect(el.dataset.empty).toBe('false')
    } finally {
      await destroy()
    }
  })

  it('input rule >>> inserts an expanded empty toggle', async () => {
    const { view, destroy } = await createToggleEditor('')
    try {
      const schema = view.state.schema
      const text = '>>> '
      const paragraph = schema.nodes.paragraph!.create(null, schema.text(text))
      const state = EditorState.create({
        schema,
        doc: schema.nodes.doc!.create(null, paragraph),
      })
      const start = 1
      const end = start + text.length
      const match = /^>>>\s$/.exec(text)
      expect(match).toBeTruthy()

      const tr = applyToggleInputRule(state, match!, start, end, schema.nodes.toggle)
      expect(tr).toBeTruthy()
      const next = state.apply(tr!)
      expect(next.doc.firstChild?.type.name).toBe(TOGGLE_TYPE)
      expect(next.doc.firstChild?.attrs.open).toBe(true)
      expect(next.doc.firstChild?.attrs.title).toBe('')
    } finally {
      await destroy()
    }
  })
})
