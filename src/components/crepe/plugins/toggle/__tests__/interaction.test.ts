import { closeHistory, redo, undo, undoDepth } from '@milkdown/prose/history'
import { DOMParser, DOMSerializer, Fragment, Slice } from '@milkdown/prose/model'
import { NodeSelection } from '@milkdown/prose/state'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { duplicateCrepeBlock, deleteCrepeBlock, turnCrepeBlockInto } from '../../../blockMenuCommands'
import { resolveBlockTarget } from '../../../blockTarget'
import { createToggleNode, revealToggleAtPosition, unwrapToggle } from '../index'
import { bodyStart, createToggleEditor, key, select, typeText } from './fixture'

describe('real Crepe toggle interaction', () => {
  it.each([false, true])('arrow click/Enter/Space change only this view (readOnly=%s)', async (readOnly) => {
    const f = await createToggleEditor('> [!toggle] title\n> body', readOnly)
    const other = await createToggleEditor('> [!toggle] title\n> body', readOnly)
    try {
      const user = userEvent.setup()
      const doc = f.view.state.doc
      const markdown = f.crepe.getMarkdown()
      const dispatch = vi.spyOn(f.view, 'dispatch')
      const el = f.root.querySelector<HTMLElement>('.milkdown-toggle')!
      const arrow = el.querySelector('button')!
      await user.click(arrow)
      expect(el.dataset.viewOpen).toBe('false')
      expect(el.querySelector('[data-toggle-body]')?.hasAttribute('inert')).toBe(true)
      await user.keyboard('{Enter}')
      expect(el.dataset.viewOpen).toBe('true')
      await user.keyboard(' ')
      expect(el.dataset.viewOpen).toBe('false')
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(dispatch).not.toHaveBeenCalled()
      expect(f.view.state.doc).toBe(doc)
      expect(undoDepth(f.view.state)).toBe(0)
      expect(f.crepe.getMarkdown()).toBe(markdown)
      expect(el.dataset.open).toBe('true')
      expect(other.root.querySelector<HTMLElement>('.milkdown-toggle')!.dataset.viewOpen).toBe('true')
    } finally { await f.destroy(); await other.destroy() }
  })

  it('typing, selection replacement, input rules, undo/redo all use PM title text', async () => {
    const f = await createToggleEditor('')
    try {
      select(f.view, 1)
      typeText(f.view, '>>> ')
      expect(f.view.state.doc.firstChild!.type.name).toBe('toggle')
      expect(f.view.state.selection.$from.parent.type.name).toBe('toggleTitle')
      f.view.dispatch(closeHistory(f.view.state.tr))
      typeText(f.view, '# **literal** >>> [link](url) 中文')
      expect(f.view.state.doc.firstChild!.child(0).textContent).toBe('# **literal** >>> [link](url) 中文')
      expect(f.view.state.doc.firstChild!.child(0).firstChild!.marks).toEqual([])
      expect(f.view.state.doc.firstChild!.attrs.title).toBeUndefined()
      const titleDOM = f.root.querySelector('[data-toggle-title]')!
      expect(titleDOM.hasAttribute('contenteditable')).toBe(false)
      expect(f.view.posAtDOM(titleDOM, 0)).toBe(2)
      expect(undo(f.view.state, f.view.dispatch)).toBe(true)
      expect(f.view.state.doc.firstChild!.child(0).textContent).toBe('')
      expect(redo(f.view.state, f.view.dispatch)).toBe(true)
      select(f.view, 2, 3)
      typeText(f.view, '搜索替换')
      expect(f.view.state.doc.textBetween(2, 6)).toBe('搜索替换')
      expect(f.parse(f.crepe.getMarkdown())!.firstChild!.eq(f.view.state.doc.firstChild!)).toBe(true)
      f.view.state.doc.check()
    } finally { await f.destroy() }
  })

  it('PM DOM observer consumes title IME changes; composing Enter is not navigation', async () => {
    const f = await createToggleEditor('> [!toggle]- 旧标题\n> 正文')
    try {
      select(f.view, 2)
      const el = f.root.querySelector<HTMLElement>('.milkdown-toggle')!
      const title = el.querySelector('[data-toggle-title]')!
      expect(key(f.view, 'Enter', { isComposing: true })).toBe(false)
      expect(key(f.view, 'Enter', { keyCode: 229 })).toBe(false)
      f.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      title.firstChild!.textContent = '中文输入'
      f.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文输入' }))
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(f.view.state.doc.firstChild!.child(0).textContent).toBe('中文输入')
      expect(el.dataset.viewOpen).toBe('false')
      expect(undo(f.view.state, f.view.dispatch)).toBe(true)
      expect(f.view.state.doc.firstChild!.child(0).textContent).toBe('旧标题')
      // PM's Safari guard consumes Enter for 500ms after compositionend.
      await new Promise((resolve) => setTimeout(resolve, 510))
      select(f.view, 2)
      expect(key(f.view, 'Enter')).toBe(true)
      expect(f.view.state.selection.from).toBe(bodyStart(f.view))
      expect(el.dataset.viewOpen).toBe('true')
      expect(f.view.state.doc.firstChild!.attrs.open).toBe(false)
    } finally { await f.destroy() }
  })

  it('Enter/Tab/Delete title edges enter body; Backspace/Shift-Tab body start return to title', async () => {
    const f = await createToggleEditor('> [!toggle]- Title\n> **body**\n\noutside')
    try {
      const before = f.view.state.doc
      for (const input of ['Enter', 'Tab', 'Delete']) {
        select(f.view, before.firstChild!.child(0).nodeSize)
        expect(key(f.view, input)).toBe(true)
        expect(f.view.state.selection.from).toBe(bodyStart(f.view))
        expect(key(f.view, 'Tab', { shiftKey: true })).toBe(true)
        expect(f.view.state.selection.$from.parent.type.name).toBe('toggleTitle')
        select(f.view, bodyStart(f.view))
        expect(key(f.view, 'Backspace')).toBe(true)
        expect(f.view.state.selection.from).toBe(before.firstChild!.child(0).nodeSize)
      }
      expect(f.view.state.doc).toBe(before)
      expect(undoDepth(f.view.state)).toBe(0)
    } finally { await f.destroy() }
  })

  it('Backspace at title start losslessly unwraps nested body and undo restores the structure', async () => {
    const f = await createToggleEditor('> [!toggle]- Title\n> **body**\n>\n> - item\n>\n> > [!toggle]- Nested\n> > inner')
    try {
      select(f.view, 2)
      const before = f.view.state.doc
      expect(key(f.view, 'Backspace')).toBe(true)
      expect(f.view.state.doc.firstChild!.type.name).toBe('paragraph')
      expect(f.view.state.doc.firstChild!.textContent).toBe('Title')
      const start = f.view.state.doc.firstChild!.nodeSize
      expect(f.view.state.doc.content.cut(start, start + before.firstChild!.child(1).content.size).eq(before.firstChild!.child(1).content)).toBe(true)
      f.view.state.doc.check()
      expect(undo(f.view.state, f.view.dispatch)).toBe(true)
      expect(f.view.state.doc.eq(before)).toBe(true)
    } finally { await f.destroy() }
  })

  it('last empty body paragraph exits, but Enter in a nested list uses native list editing', async () => {
    const f = await createToggleEditor('> [!toggle] title\n> - item')
    try {
      const { view } = f
      let itemTextPos = 0
      view.state.doc.descendants((node, pos) => { if (node.isText && node.text === 'item') itemTextPos = pos })
      select(view, itemTextPos + 4)
      expect(key(view, 'Enter')).toBe(true)
      expect(view.state.selection.$from.parent.type.name).toBe('paragraph')
      expect(view.state.selection.$from.node(-1).type.name).toBe('list_item')
      const toggle = view.state.doc.firstChild!
      const insertAt = toggle.nodeSize - 2
      view.dispatch(view.state.tr.insert(insertAt, view.state.schema.nodes.paragraph.create()))
      select(view, insertAt + 1)
      const countBefore = view.state.doc.childCount
      expect(key(view, 'Enter')).toBe(true)
      expect(view.state.selection.$from.depth).toBe(1)
      expect(view.state.doc.childCount).toBe(countBefore + 1)
      view.state.doc.check()
    } finally { await f.destroy() }
  })

  it('only-empty body Backspace preserves title whitespace and title-only toggles remain valid', async () => {
    const f = await createToggleEditor('')
    try {
      f.view.dispatch(f.view.state.tr.replaceWith(0, f.view.state.doc.content.size, createToggleNode(f.view.state.schema, '  title  ')))
      select(f.view, bodyStart(f.view))
      expect(key(f.view, 'Backspace')).toBe(true)
      expect(f.view.state.doc.firstChild!.textContent).toBe('  title  ')
      expect(f.view.state.doc.firstChild!.type.name).toBe('paragraph')
    } finally { await f.destroy() }
  })

  it('rich/multiline paste in title is plain text and undoable', async () => {
    const f = await createToggleEditor('> [!toggle] Old\n> body')
    try {
      select(f.view, 2, 5)
      const event = new Event('paste') as ClipboardEvent
      Object.defineProperty(event, 'clipboardData', { value: { getData: () => '**plain**\nsecond' } })
      const slice = new Slice(Fragment.from(f.view.state.schema.nodes.paragraph.create(null, f.view.state.schema.text('rich', [f.view.state.schema.marks.strong.create()]))), 0, 0)
      expect(f.view.someProp('handlePaste', (fn) => fn(f.view, event, slice))).toBe(true)
      expect(f.view.state.doc.firstChild!.child(0).textContent).toBe('**plain** second')
      expect(f.view.state.doc.firstChild!.child(0).firstChild!.marks).toEqual([])
      expect(undo(f.view.state, f.view.dispatch)).toBe(true)
      expect(f.view.state.doc.firstChild!.child(0).textContent).toBe('Old')
    } finally { await f.destroy() }
  })

  it('native clipboard copies selected title text, title/body ranges and whole toggles', async () => {
    const f = await createToggleEditor('> [!toggle]- Title\n> **body** rest\n\noutside')
    try {
      select(f.view, 2, 7)
      const titleCopy = f.view.serializeForClipboard(f.view.state.selection.content())
      expect(titleCopy.text).toBe('Title')
      select(f.view, 4, bodyStart(f.view) + 4)
      const rangeCopy = f.view.serializeForClipboard(f.view.state.selection.content())
      expect(rangeCopy.text).toContain('tle')
      expect(rangeCopy.text).toContain('body')
      expect(key(f.view, 'Backspace')).toBe(true)
      f.view.state.doc.check()
      // Native cross-textblock deletion joins the unselected suffix into title;
      // the fixed schema recreates the required empty body paragraph.
      expect(f.view.state.doc.firstChild!.child(0).textContent).toBe('Ti rest')
      expect(f.view.state.doc.firstChild!.child(1).textContent).toBe('')
      expect(undo(f.view.state, f.view.dispatch)).toBe(true)
      f.view.dispatch(f.view.state.tr.setSelection(NodeSelection.create(f.view.state.doc, 0)))
      const blockCopy = f.view.serializeForClipboard(f.view.state.selection.content())
      expect(blockCopy.text).toContain('[!toggle]- Title')
      const outsidePos = f.view.state.doc.firstChild!.nodeSize + 1
      select(f.view, outsidePos, outsidePos + 7)
      const paste = new Event('paste') as ClipboardEvent
      Object.defineProperty(paste, 'clipboardData', { value: {
        getData: (format: string) => format === 'text/html' ? blockCopy.dom.innerHTML : format === 'text/plain' ? blockCopy.text : '',
      } })
      expect(f.view.pasteHTML(blockCopy.dom.innerHTML, paste)).toBe(true)
      f.view.state.doc.check()
      const toggles: string[] = []
      f.view.state.doc.descendants((node) => { if (node.type.name === 'toggle') toggles.push(node.child(0).textContent) })
      expect(toggles).toEqual(['Title', 'Title'])
    } finally { await f.destroy() }
  })

  it('nested search reveal is reversible, composes owners, and never changes doc/history', async () => {
    const f = await createToggleEditor('> [!toggle]- Outer\n>\n> > [!toggle]- Inner\n> > needle', true)
    try {
      const doc = f.view.state.doc
      let pos = 0
      doc.descendants((node, at) => { if (node.isText && node.text === 'needle') pos = at })
      const els = f.root.querySelectorAll<HTMLElement>('.milkdown-toggle')
      const dispatch = vi.spyOn(f.view, 'dispatch')
      const release = revealToggleAtPosition(f.view, pos)
      const release2 = revealToggleAtPosition(f.view, pos)
      expect(Array.from(els, (el) => el.dataset.viewOpen)).toEqual(['true', 'true'])
      release()
      expect(els[1].dataset.viewOpen).toBe('true')
      els[1].querySelector('button')!.click() // local preference survives release
      release2()
      expect(Array.from(els, (el) => el.dataset.viewOpen)).toEqual(['false', 'true'])
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(dispatch).not.toHaveBeenCalled()
      expect(f.view.state.doc).toBe(doc)
      expect(undoDepth(f.view.state)).toBe(0)
      expect(getComputedStyle(els[0].querySelector('button')!).transform).toBe('rotate(0deg)')
      expect(getComputedStyle(els[1].querySelector('button')!).transform).toBe('rotate(90deg)')
    } finally { await f.destroy() }
  })

  it('local open survives title/body edits, undo and author-default changes', async () => {
    const f = await createToggleEditor('> [!toggle]- Title\n> body')
    try {
      const el = f.root.querySelector<HTMLElement>('.milkdown-toggle')!
      el.querySelector('button')!.click()
      select(f.view, 2)
      typeText(f.view, 'new')
      expect(el.dataset.viewOpen).toBe('true')
      undo(f.view.state, f.view.dispatch)
      expect(el.dataset.viewOpen).toBe('true')
      f.view.dispatch(f.view.state.tr.setNodeMarkup(0, undefined, { open: true }))
      el.querySelector('button')!.click()
      f.view.dispatch(f.view.state.tr.insertText('new', bodyStart(f.view)))
      expect(el.dataset.viewOpen).toBe('false')
      expect(el.dataset.open).toBe('true')
    } finally { await f.destroy() }
  })

  it('full-block DOM copy, duplicate, delete and conversion preserve formal children', async () => {
    const f = await createToggleEditor('> [!toggle]- Title\n> **body**\n\noutside')
    try {
      const node = f.view.state.doc.firstChild!
      f.view.dispatch(f.view.state.tr.setSelection(NodeSelection.create(f.view.state.doc, 0)))
      const wrapper = document.createElement('div')
      wrapper.append(DOMSerializer.fromSchema(f.view.state.schema).serializeFragment(f.view.state.selection.content().content))
      expect(DOMParser.fromSchema(f.view.state.schema).parse(wrapper).firstChild!.eq(node)).toBe(true)
      expect(duplicateCrepeBlock(f.view, 0)).toBe(true)
      expect(f.view.state.doc.child(1).eq(node)).toBe(true)
      expect(deleteCrepeBlock(f.view, resolveBlockTarget(f.view, 0)!)).toBe(true)
      expect(f.view.state.doc.firstChild!.eq(node)).toBe(true)
      expect(unwrapToggle(f.view, 0)).toBe(true)
      expect(turnCrepeBlockInto(f.view, 0, 'heading-2')).toBe(true)
      expect(f.view.state.doc.firstChild!.textContent).toBe('Title')
      expect(f.view.state.doc.child(1).firstChild!.marks[0].type.name).toBe('strong')
      f.view.state.doc.check()
    } finally { await f.destroy() }
  })

  it('readOnly is inherited by title/body; arrow remains usable and editing resumes', async () => {
    const f = await createToggleEditor('> [!toggle]- Title\n> body')
    try {
      select(f.view, 2)
      f.crepe.setReadonly(true)
      const before = f.view.state.doc
      expect(f.view.dom.getAttribute('contenteditable')).toBe('false')
      expect(f.root.querySelector('[data-toggle-title][contenteditable]')).toBeNull()
      expect(key(f.view, 'Enter')).toBe(false)
      expect(unwrapToggle(f.view, 0)).toBe(false)
      expect(duplicateCrepeBlock(f.view, 0)).toBe(false)
      expect(deleteCrepeBlock(f.view, 0)).toBe(false)
      expect(f.view.someProp('handleTextInput', (fn) => fn(f.view, 2, 2, 'x', () => f.view.state.tr.insertText('x')))).not.toBe(true)
      expect(f.view.state.doc).toBe(before)
      f.crepe.setReadonly(false)
      typeText(f.view, 'new')
      expect(f.view.state.doc.firstChild!.child(0).textContent).toBe('newTitle')
    } finally { await f.destroy() }
  })
})
