import { Editor, defaultValueCtx, editorViewCtx, rootCtx, serializerCtx } from '@milkdown/core'
import { commonmark } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'
import { history, undo, redo, undoDepth } from '@milkdown/prose/history'
import { NodeSelection, TextSelection } from '@milkdown/prose/state'
import { Fragment, DOMSerializer, DOMParser, Slice } from '@milkdown/prose/model'
import { $prose, getMarkdown } from '@milkdown/utils'
import { afterEach, describe, expect, it } from 'vitest'
import { performance } from 'node:perf_hooks'
import { Crepe } from '@milkdown/crepe'
import { togglePlugin } from '../../toggle'
import { calloutPlugin } from '../../callout'
import {
  COLUMNS_TYPE, COLUMN_TYPE, columnsPlugin, columnsOpen, createColumnsNode,
  insertColumns, insertCornell, convertSelectionToColumns, convertSelectionToCornell,
  convertCornellTemplate, unwrapColumns, exitColumns,
  exportColumnsPlainMarkdown, columnsClipboardMarkdown, createColumnsValidator,
} from '../index'
import { availableNoteLayoutActions } from '@/features/notes/components/NoteLayoutCommands'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

async function setup(markdown = '', canWrite: () => boolean = () => true) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const editor = Editor.make().config((ctx) => {
    ctx.set(rootCtx, root)
    ctx.set(defaultValueCtx, markdown)
  }).use(commonmark).use(gfm).use(togglePlugin()).use(calloutPlugin())
    .use(columnsPlugin({ canWrite })).use($prose(() => history()))
  await editor.create()
  cleanup.push(async () => { await editor.destroy(); root.remove() })
  const view = editor.ctx.get(editorViewCtx)
  const serialize = editor.ctx.get(serializerCtx)
  return { editor, root, view, serialize, markdown: () => editor.action(getMarkdown()) }
}

function source(left = 'Left', right = 'Right', layout: 'equal' | 'cornell' = 'equal') {
  return `${columnsOpen(layout)}\n\n:::column\n\n${left}\n\n:::end-column\n\n:::column\n\n${right}\n\n:::end-column\n\n:::end-ds-columns\n`
}

function textPos(doc: import('@milkdown/prose/model').Node, text: string): number {
  let pos = -1
  doc.descendants((node, at) => { if (pos === -1 && node.isText && node.text?.includes(text)) pos = at + node.text.indexOf(text) })
  if (pos < 0) throw new Error(`Missing ${text}`)
  return pos
}

function press(view: import('@milkdown/prose/view').EditorView, key: string, extra: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, ...extra })
  return view.someProp('handleKeyDown', (handler) => handler(view, event))
}

function clipboardEvent(type: 'copy' | 'cut' | 'paste', plain = '') {
  const values = new Map([['text/plain', plain]])
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: {
    files: [], types: ['text/plain'],
    getData: (key: string) => values.get(key) ?? '',
    setData: (key: string, value: string) => values.set(key, value),
    clearData: () => values.clear(),
  } })
  return { event, values }
}

describe('ds-columns Markdown contract', () => {
  it('roundtrips actual schema, marks, tables, code, links, image, toggle and callout', async () => {
    const left = '## Cues\n\n**bold** *emphasis* [link](https://example.com) ![image](notes_assets/a.png)\n\n- one\n- two\n\n> [!NOTE] Title\n> quote'
    const right = '| A | B |\n| - | - |\n| wide content | cell |\n\n> [!toggle]- Hidden\n> **inside**\n\n```text\n:::column\n:::end-ds-columns\n```'
    const first = await setup(source(left, right, 'cornell') + '\n## Summary\n\nConclusion\n')
    const columns = first.view.state.doc.firstChild!
    expect(columns.type.name).toBe(COLUMNS_TYPE)
    expect(columns.childCount).toBe(2)
    expect(columns.child(0).type.name).toBe(COLUMN_TYPE)
    expect(first.root.querySelectorAll('[data-ds-column]')).toHaveLength(2)
    expect(first.root.querySelector('table')).not.toBeNull()
    const out = first.markdown()
    const again = await setup(out)
    expect(again.view.state.doc.toJSON()).toEqual(first.view.state.doc.toJSON())
    expect(again.markdown()).toBe(out)
    expect(out).toContain(':::ds-columns{version=1 layout=cornell}')
    const plain = exportColumnsPlainMarkdown(first.view.state.doc, first.serialize)
    expect(plain).not.toContain('ds-columns{')
    expect(plain.indexOf('Cues')).toBeLessThan(plain.indexOf('wide content'))
    expect(plain.indexOf('wide content')).toBeLessThan(plain.indexOf('Summary'))
    expect(plain).toContain('notes_assets/a.png')
    expect(plain).toContain('**inside**')
    expect(plain).toContain(':::end-ds-columns') // literal code is preserved
  })

  it('preserves empty columns through serialization', async () => {
    const first = await setup(source('', ''))
    expect(first.view.state.doc.firstChild?.child(0).childCount).toBe(1)
    const again = await setup(first.markdown())
    expect(again.view.state.doc.toJSON()).toEqual(first.view.state.doc.toJSON())
  })

  it.each([
    ['unknown version', source().replace('version=1', 'version=2')],
    ['third column', source().replace(':::end-ds-columns', ':::column\n\nThird\n\n:::end-column\n\n:::end-ds-columns')],
    ['nested', source(source('Nested Left', 'Nested Right'), 'Outer right')],
    ['missing end', source().replace(':::end-ds-columns', '')],
    ['escaped literal', source().replace(':::ds-columns', '\\:::ds-columns')],
    ['quoted', source().split('\n').map((line) => `> ${line}`).join('\n')],
    ['code', '```\n' + source() + '\n```'],
  ])('does not upgrade %s and retains content', async (_name, input) => {
    const first = await setup(input)
    expect(first.root.querySelector('[data-ds-columns]')).toBeNull()
    expect(first.view.state.doc.textContent).toContain('Left')
    expect(first.view.state.doc.textContent).toContain('Right')
    const again = await setup(first.markdown())
    expect(again.view.state.doc.toJSON()).toEqual(first.view.state.doc.toJSON())
    expect(again.root.querySelector('[data-ds-columns]')).toBeNull()
  })

  it('roundtrips structured HTML clipboard and degrades plain clipboard in reading order', async () => {
    const { view, serialize } = await setup(source('Left **strong**', 'Right *em*') + '\nSummary\n')
    const doc = view.state.doc
    const dom = document.createElement('div')
    dom.appendChild(DOMSerializer.fromSchema(view.state.schema).serializeFragment(doc.content))
    const parsed = DOMParser.fromSchema(view.state.schema).parse(dom)
    expect(parsed.eq(doc)).toBe(true)
    const whole = new Slice(doc.content, 0, 0)
    const text = columnsClipboardMarkdown(whole, doc, serialize)
    expect(text).not.toContain(':::')
    expect(text.indexOf('Left')).toBeLessThan(text.indexOf('Right'))
    expect(text.indexOf('Right')).toBeLessThan(text.indexOf('Summary'))
    expect(text).toContain('**strong**')
    const partial = doc.slice(textPos(doc, 'strong') + 1, textPos(doc, 'Right') + 3)
    const copied = columnsClipboardMarkdown(partial, doc, serialize)
    expect(copied).toContain('trong')
    expect(copied).toContain('Rig')
    expect(copied).not.toContain(':::')
  })

  it('uses actual Crepe copy/cut events despite its built-in clipboard serializer; retains math', async () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    const crepe = new Crepe({ root, defaultValue: source('Left **strong**', 'Right $x^2$') })
    crepe.editor.use(columnsPlugin({ canWrite: () => true }))
    await crepe.create()
    cleanup.push(async () => { await crepe.destroy(); root.remove() })
    const view = crepe.editor.ctx.get(editorViewCtx)
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 0)))
    const original = view.state.doc
    for (const type of ['copy', 'cut'] as const) {
      const { event, values } = clipboardEvent(type)
      view.dom.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
      expect(values.get('text/plain')).toContain('**strong**')
      expect(values.get('text/plain')).toContain('$x^2$')
      expect(values.get('text/plain')).not.toContain(':::')
      expect(values.get('text/html')).toContain('data-ds-columns="1"')
      expect(values.get('text/html')).toContain('data-pm-slice')
    }
    expect(view.state.doc.textContent).not.toContain('Left')
    expect(undo(view.state, view.dispatch)).toBe(true)
    expect(view.state.doc.eq(original)).toBe(true)
  })

  it('handles directive plain paste at root and inside a column without losing either side', async () => {
    const { view } = await setup('Target')
    view.dom.dispatchEvent(clipboardEvent('paste', source('Pasted left', 'Pasted right')).event)
    expect(view.state.doc.textContent).toContain('Pasted left')
    expect(view.state.doc.textContent).toContain('Pasted right')
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, textPos(view.state.doc, 'Pasted left'))))
    view.dom.dispatchEvent(clipboardEvent('paste', source('Inner left', 'Inner right')).event)
    expect(view.state.doc.textContent).toContain('Inner left')
    expect(view.state.doc.textContent).toContain('Inner right')
    let count = 0
    view.state.doc.descendants((node) => { if (node.type.name === COLUMNS_TYPE) count++ })
    expect(count).toBe(1)
    const legacy = await setup('Legacy', () => false)
    legacy.view.dom.dispatchEvent(clipboardEvent('paste', source('Allowed text', 'Other text')).event)
    expect(legacy.view.state.doc.textContent).toContain('Allowed text')
    expect(legacy.view.state.doc.textContent).toContain('Other text')
    expect(legacy.root.querySelector('[data-ds-columns]')).toBeNull()
  })
})

describe('explicit commands, selection and history', () => {
  it('inserts a real Cornell node and full-width summary in one undo step', async () => {
    const { view } = await setup()
    const before = view.state.doc
    expect(insertCornell()(view.state)).toBe(true)
    expect(view.state.doc).toBe(before)
    expect(insertCornell()(view.state, view.dispatch)).toBe(true)
    expect(view.state.doc.firstChild?.attrs.layout).toBe('cornell')
    expect(view.state.selection.$from.parent.type.name).toBe('paragraph')
    expect(view.state.selection.$from.depth).toBe(3)
    expect(view.state.doc.child(1).textContent).toContain('Summary')
    const after = view.state.doc
    expect(undoDepth(view.state)).toBe(1)
    expect(undo(view.state, view.dispatch)).toBe(true)
    expect(view.state.doc.eq(before)).toBe(true)
    expect(redo(view.state, view.dispatch)).toBe(true)
    expect(view.state.doc.eq(after)).toBe(true)
  })

  it('converts a selected block range, preserves outside blocks, unwraps in order, undoes', async () => {
    const { view } = await setup('Before\n\nAlpha\n\nBeta\n\nAfter\n')
    const before = view.state.doc
    view.dispatch(view.state.tr.setSelection(TextSelection.create(before, textPos(before, 'Alpha'), textPos(before, 'After'))))
    expect(convertSelectionToColumns()(view.state, view.dispatch)).toBe(true)
    expect(view.state.doc.child(0).textContent).toBe('Before')
    expect(view.state.doc.child(1).child(0).textContent).toBe('AlphaBeta')
    expect(view.state.doc.lastChild?.textContent).toBe('After')
    expect(view.state.selection).toBeInstanceOf(NodeSelection)
    expect(unwrapColumns(view.state, view.dispatch)).toBe(true)
    expect(view.state.doc.textContent).toBe(before.textContent)
    expect(undo(view.state, view.dispatch)).toBe(true)
    expect(view.state.doc.child(1).type.name).toBe(COLUMNS_TYPE)
    expect(undo(view.state, view.dispatch)).toBe(true)
    expect(view.state.doc.eq(before)).toBe(true)
  })

  it('converts the existing Cornell template without losing preface, sections or summary', async () => {
    const { view } = await setup('> Date\n\n## 线索（Cues）\n\nQuestion\n\n## 笔记（Notes）\n\nAnswer\n\n## 总结（Summary）\n\nConclusion\n')
    const before = view.state.doc
    expect(convertCornellTemplate()(view.state, view.dispatch)).toBe(true)
    expect(view.state.doc.child(0)).toBe(before.child(0))
    expect(view.state.doc.child(1).child(0).textContent).toContain('Question')
    expect(view.state.doc.child(1).child(1).textContent).toContain('Answer')
    expect(view.state.doc.child(2).textContent).toContain('Summary')
    expect(view.state.doc.textContent).toBe(before.textContent)
    expect(convertCornellTemplate()(view.state)).toBe(false)
    expect(undo(view.state, view.dispatch)).toBe(true)
    expect(view.state.doc.eq(before)).toBe(true)
  })

  it('converts arbitrary notes to Cornell without discarding selected marks', async () => {
    const { view } = await setup('**Original**')
    expect(convertSelectionToCornell()(view.state, view.dispatch)).toBe(true)
    expect(view.state.doc.firstChild?.child(1).lastChild?.firstChild?.marks[0].type.name).toBe('strong')
  })

  it('does not expose unusable layout actions or write when format gate is closed', async () => {
    let granted = false
    const { view } = await setup('', () => granted)
    expect(availableNoteLayoutActions(view)).toEqual([])
    expect(insertColumns()(view.state, view.dispatch)).toBe(false)
    granted = true
    expect(insertColumns()(view.state, view.dispatch)).toBe(true)
    granted = false
    const before = view.state.doc
    view.dispatch(view.state.tr.insertText('blocked'))
    expect(view.state.doc).toBe(before)
    expect(availableNoteLayoutActions(view)).toEqual([])
  })

  it('rejects nesting through commands and transactions even after validation cached the layout', async () => {
    const { view } = await setup(source())
    const valid = createColumnsValidator()
    expect(valid(view.state.doc)).toBe(true)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, textPos(view.state.doc, 'Left'))))
    expect(insertColumns()(view.state)).toBe(false)
    expect(convertSelectionToColumns()(view.state)).toBe(false)
    const node = view.state.doc.firstChild!
    const nested = view.state.schema.nodes.blockquote.create(null, node)
    expect(valid(view.state.schema.nodes.doc.create(null, nested))).toBe(false)
    const before = view.state.doc
    view.dispatch(view.state.tr.insert(2, node))
    expect(view.state.doc).toBe(before)
    expect(() => view.state.schema.nodes[COLUMNS_TYPE].createChecked(null, [node.child(0), node.child(1), node.child(0)])).toThrow()
  })

  it('degrades nested paste to content, retaining both columns', async () => {
    const { view } = await setup(source())
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, textPos(view.state.doc, 'Left'))))
    let slice = new Slice(Fragment.from(view.state.doc.firstChild!), 0, 0)
    view.someProp('transformPasted', (handler) => { slice = handler(slice, view, false) })
    view.dispatch(view.state.tr.replaceSelection(slice))
    expect(view.state.doc.firstChild?.child(0).textContent).toContain('Right')
    let count = 0
    view.state.doc.descendants((node) => { if (node.type.name === COLUMNS_TYPE) count++ })
    expect(count).toBe(1)
  })

  it('allows cross-column text selection deletion without invalidating or reordering structure', async () => {
    const { view } = await setup(source('ABC', 'DEF'))
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, textPos(view.state.doc, 'ABC') + 1, textPos(view.state.doc, 'DEF') + 2)))
    view.dispatch(view.state.tr.deleteSelection())
    expect(view.state.doc.firstChild?.childCount).toBe(2)
    expect(view.state.doc.textContent).toBe('AF')
    expect(undo(view.state, view.dispatch)).toBe(true)
    expect(view.state.doc.textContent).toBe('ABCDEF')
  })
})

describe('keyboard boundaries and editing cost', () => {
  it('blocks joins at column boundaries and ignores composing input', async () => {
    const { view } = await setup(source())
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, textPos(view.state.doc, 'Right'))))
    expect(press(view, 'Backspace')).toBe(true)
    expect(press(view, 'Backspace', { isComposing: true })).not.toBe(true)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, textPos(view.state.doc, 'Left') + 4)))
    expect(press(view, 'Delete')).toBe(true)
    expect(press(view, 'ArrowRight')).not.toBe(true)
    expect(press(view, 'Tab')).not.toBe(true)
  })

  it('Enter on final empty blocks advances left→right→outside; Mod-Enter exits directly', async () => {
    const { view } = await setup(source('', ''))
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)))
    expect(press(view, 'Enter')).toBe(true)
    expect(view.state.selection.$from.index(1)).toBe(1)
    expect(press(view, 'Enter')).toBe(true)
    expect(view.state.selection.$from.depth).toBe(1)
    expect(view.state.doc.childCount).toBe(2)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)))
    expect(press(view, 'Enter', { metaKey: true })).toBe(true)
    expect(view.state.selection.$from.depth).toBe(1)
    expect(view.state.doc.childCount).toBe(2)
    expect(exitColumns(view.state)).toBe(false)
  })

  it('validates large columns with shared immutable subtrees during repeated typing', async () => {
    const { view } = await setup()
    const p = (text: string) => view.state.schema.nodes.paragraph.create(null, view.state.schema.text(text))
    const blocks = Fragment.from(Array.from({ length: 2000 }, (_, i) => p(`block ${i}`)))
    const layout = createColumnsNode(view.state.schema, 'equal', blocks, blocks)
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, layout))
    const start = performance.now()
    for (let i = 0; i < 50; i++) view.dispatch(view.state.tr.insertText('x', 3))
    const elapsed = performance.now() - start
    expect(view.state.doc.firstChild?.child(0).firstChild?.textContent).toBe('x'.repeat(50) + 'block 0')
    // Gross regression guard, not a device latency SLA (includes jsdom view updates).
    expect(elapsed).toBeLessThan(3000)
    console.info(`WP11 4000 blocks / 50 edits: ${elapsed.toFixed(1)} ms`)
  })
})
