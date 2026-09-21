import { Editor, defaultValueCtx, editorViewCtx, editorViewOptionsCtx, rootCtx } from '@milkdown/core'
import { commonmark } from '@milkdown/preset-commonmark'
import { history, undo, undoDepth } from '@milkdown/prose/history'
import { EditorState, TextSelection } from '@milkdown/prose/state'
import { $prose, getMarkdown } from '@milkdown/utils'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { applyToggleInputRule } from '../input-rule'
import {
  TOGGLE_TYPE,
  togglePlugin,
  tryExitToggleOnEnter,
  tryUnwrapEmptyToggleOnBackspace,
} from '../index'

async function createToggleEditor(markdown: string, readOnly = false) {
  const root = document.createElement('div')
  document.body.appendChild(root)

  const editor = Editor.make()
  editor.config((ctx) => {
    ctx.set(rootCtx, root)
    ctx.set(defaultValueCtx, markdown)
    ctx.update(editorViewOptionsCtx, (options) => ({
      ...options,
      editable: () => !readOnly,
      handleScrollToSelection: () => true, // jsdom has no Range layout API.
    }))
  })
  editor.use(commonmark)
  editor.use(togglePlugin())
  editor.use($prose(() => history()))
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
  it.each([false, true])('arrow click/Enter/Space only change this view (readOnly=%s)', async (readOnly) => {
    const source = `> [!toggle] 可切换
> body
`
    const { editor, root, view, destroy } = await createToggleEditor(source, readOnly)
    const other = await createToggleEditor(source, readOnly)
    try {
      const user = userEvent.setup()
      const beforeDoc = view.state.doc
      const beforeMarkdown = editor.action(getMarkdown())
      const dispatch = vi.spyOn(view, 'dispatch')
      const toggleEl = root.querySelector('.milkdown-toggle') as HTMLElement | null
      expect(toggleEl).toBeTruthy()
      expect(toggleEl!.dataset.viewOpen).toBe('true')

      const arrow = toggleEl!.querySelector('.milkdown-toggle__arrow') as HTMLButtonElement
      expect(arrow).toBeTruthy()
      expect(arrow.type).toBe('button')
      expect(arrow.getAttribute('aria-label')).toBeTruthy()
      expect(arrow.getAttribute('aria-expanded')).toBe('true')

      arrow.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      expect(toggleEl!.dataset.viewOpen).toBe('true')
      await user.click(arrow)
      expect(toggleEl!.dataset.viewOpen).toBe('false')
      expect(arrow.getAttribute('aria-expanded')).toBe('false')
      const body = toggleEl!.querySelector('.milkdown-toggle__body')!
      expect(body.getAttribute('aria-hidden')).toBe('true')
      expect(body.hasAttribute('inert')).toBe(true)

      await user.keyboard('{Enter}')
      expect(toggleEl!.dataset.viewOpen).toBe('true')
      expect(arrow.getAttribute('aria-expanded')).toBe('true')
      expect(body.hasAttribute('inert')).toBe(false)
      await user.keyboard(' ')
      expect(toggleEl!.dataset.viewOpen).toBe('false')
      // Let PM's MutationObserver process DOM changes, detecting accidental reparsing.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(dispatch).not.toHaveBeenCalled()
      expect(view.state.doc).toBe(beforeDoc)
      expect(undoDepth(view.state)).toBe(0)
      expect(editor.action(getMarkdown())).toBe(beforeMarkdown)
      expect(toggleEl!.dataset.open).toBe('true')
      expect((other.root.querySelector('.milkdown-toggle') as HTMLElement).dataset.viewOpen).toBe('true')
    } finally {
      await destroy()
      await other.destroy()
    }
  })

  it('keeps the local expansion across body edits, undo and author-default updates', async () => {
    const { editor, root, view, destroy } = await createToggleEditor('> [!toggle]- 标题\n> **正文**\n')
    try {
      const el = root.querySelector('.milkdown-toggle') as HTMLElement
      const pos = findTogglePos(view.state.doc)!
      const before = editor.action(getMarkdown())
      ;(el.querySelector('button') as HTMLButtonElement).click()
      view.dispatch(view.state.tr.insertText('新增', pos + 2))
      expect(el.dataset.viewOpen).toBe('true')
      expect(undoDepth(view.state)).toBe(1)
      expect(undo(view.state, view.dispatch)).toBe(true)
      expect(el.dataset.viewOpen).toBe('true')
      expect(editor.action(getMarkdown())).toBe(before)
      expect(view.state.doc.nodeAt(pos)?.attrs.open).toBe(false)
      expect(root.querySelector('strong')?.textContent).toBe('正文')
      view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { title: '默认已修改', open: true }))
      ;(el.querySelector('button') as HTMLButtonElement).click()
      view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { title: '再次修改', open: true }))
      expect(el.dataset.viewOpen).toBe('false')
      expect(el.dataset.open).toBe('true')
    } finally {
      await destroy()
    }
  })

  it('guards IME Enter and commits title once before entering the locally expanded body', async () => {
    const { root, view, destroy } = await createToggleEditor('> [!toggle]- 旧标题\n> 正文\n')
    try {
      const el = root.querySelector('.milkdown-toggle') as HTMLElement
      const title = el.querySelector('.milkdown-toggle__title') as HTMLElement
      title.tabIndex = 0 // jsdom does not make contentEditable properties focusable.
      title.focus()
      title.textContent = '输入中的标题'
      const dispatch = vi.spyOn(view, 'dispatch')
      for (const options of [{ isComposing: true }, { keyCode: 229 }]) {
        const event = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, ...options })
        title.dispatchEvent(event)
        expect(event.defaultPrevented).toBe(false)
      }
      title.dispatchEvent(new CompositionEvent('compositionstart'))
      title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
      expect(dispatch).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(title)
      expect(el.dataset.viewOpen).toBe('false')
      title.dispatchEvent(new CompositionEvent('compositionend'))
      title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
      title.dispatchEvent(new FocusEvent('blur'))
      expect(dispatch.mock.calls.filter(([tr]) => tr.docChanged)).toHaveLength(1)
      const pos = findTogglePos(view.state.doc)!
      expect(view.state.doc.nodeAt(pos)?.attrs).toMatchObject({ title: '输入中的标题', open: false })
      expect(el.dataset.viewOpen).toBe('true')
      expect(view.state.selection.from).toBe(pos + 2)
      expect(undoDepth(view.state)).toBe(1)
      undo(view.state, view.dispatch)
      expect(view.state.doc.nodeAt(pos)?.attrs.title).toBe('旧标题')
    } finally {
      await destroy()
    }
  })

  it('discards a title draft when switching to readOnly and resumes editing when enabled', async () => {
    const { root, view, destroy } = await createToggleEditor('> [!toggle]- 原标题\n> 正文\n')
    try {
      const title = root.querySelector('.milkdown-toggle__title') as HTMLElement
      title.tabIndex = 0
      title.focus()
      title.textContent = '未提交草稿'
      const dispatch = vi.spyOn(view, 'dispatch')
      view.setProps({ editable: () => false })
      expect(title.contentEditable).toBe('false')
      expect(title.textContent).toBe('原标题')
      title.textContent = '只读事件不能写入'
      title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
      title.dispatchEvent(new FocusEvent('blur'))
      expect(dispatch).not.toHaveBeenCalled()
      expect(view.state.doc.firstChild?.attrs.title).toBe('原标题')
      view.setProps({ editable: () => true })
      expect(title.contentEditable).toBe('true')
      expect(title.textContent).toBe('原标题')
      title.textContent = '提交标题'
      title.dispatchEvent(new FocusEvent('blur'))
      expect(view.state.doc.firstChild?.attrs.title).toBe('提交标题')
    } finally {
      await destroy()
    }
  })

  it('does not let a removed title blur write to its replacement or a destroyed editor', async () => {
    const { root, view, destroy } = await createToggleEditor('> [!toggle] 原标题\n> 正文\n')
    const title = root.querySelector('.milkdown-toggle__title') as HTMLElement
    title.tabIndex = 0
    title.focus()
    title.textContent = '待提交'
    const pos = findTogglePos(view.state.doc)!
    const toggle = view.state.doc.nodeAt(pos)!
    view.dispatch(view.state.tr.replaceWith(pos, pos + toggle.nodeSize, view.state.schema.nodes.paragraph.create()))
    const dispatch = vi.spyOn(view, 'dispatch')
    title.dispatchEvent(new FocusEvent('blur'))
    expect(dispatch).not.toHaveBeenCalled()
    expect(view.state.doc.firstChild?.type.name).toBe('paragraph')
    await destroy()
    title.dispatchEvent(new FocusEvent('blur'))
    expect(dispatch).not.toHaveBeenCalled()
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
      view.setProps({ editable: () => false })
      expect(tryExitToggleOnEnter(view)).toBe(false)
      view.setProps({ editable: () => true })
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
      expect(el.dataset.viewOpen).toBe('false')
      expect(el.querySelector('.milkdown-toggle__body')).toBeTruthy()
      expect(document.getElementById('milkdown-toggle-styles')).toBeTruthy()
    } finally {
      await destroy()
    }
  })

  it('keeps nested arrow/body styles independent of the outer expansion', async () => {
    const { root, view, destroy } = await createToggleEditor('')
    try {
      const { toggle, paragraph } = view.state.schema.nodes
      const inner = toggle.create({ title: '内层', open: false }, paragraph.create())
      const outer = toggle.create({ title: '外层', open: true }, inner)
      view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, outer))
      const arrows = root.querySelectorAll<HTMLButtonElement>('.milkdown-toggle__arrow')
      const bodies = root.querySelectorAll<HTMLElement>('.milkdown-toggle__body')
      expect(getComputedStyle(arrows[0]).transform).toBe('rotate(90deg)')
      expect(getComputedStyle(arrows[1]).transform).toBe('rotate(0deg)')
      expect(getComputedStyle(bodies[1]).gridTemplateRows).toBe('0fr')
      arrows[1].click()
      arrows[0].click()
      expect(arrows[0].getAttribute('aria-expanded')).toBe('false')
      expect(arrows[1].getAttribute('aria-expanded')).toBe('true')
      expect(getComputedStyle(bodies[1]).gridTemplateRows).toBe('1fr')
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

      view.setProps({ editable: () => false })
      expect(tryUnwrapEmptyToggleOnBackspace(view)).toBe(false)
      view.setProps({ editable: () => true })
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
