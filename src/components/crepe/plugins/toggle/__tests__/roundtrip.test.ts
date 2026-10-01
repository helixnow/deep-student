import { DOMParser, DOMSerializer } from '@milkdown/prose/model'
import { getMarkdown } from '@milkdown/utils'
import { describe, expect, it } from 'vitest'

import {
  formatToggleMarker,
  parseToggleMarker,
  TOGGLE_TYPE,
  createToggleNode,
} from '../index'
import { createToggleEditor } from './fixture'

function normalizeMarkdown(md: string): string {
  return md.replace(/\r\n/g, '\n').replace(/\n+$/, '\n').trimEnd() + '\n'
}

describe('parseToggleMarker / formatToggleMarker', () => {
  it('parses collapsed and expanded markers', () => {
    expect(parseToggleMarker('[!toggle]- Hidden')).toEqual({
      open: false,
      title: 'Hidden',
    })
    expect(parseToggleMarker('[!toggle]+ Shown')).toEqual({
      open: true,
      title: 'Shown',
    })
    expect(parseToggleMarker('[!toggle] Default open')).toEqual({
      open: true,
      title: 'Default open',
    })
    expect(parseToggleMarker('[!note] x')).toBeNull()
  })

  it('roundtrips marker formatting', () => {
    expect(formatToggleMarker('标题', false)).toBe('[!toggle]- 标题')
    expect(formatToggleMarker('标题', true)).toBe('[!toggle] 标题')
    expect(parseToggleMarker(formatToggleMarker('A', false))).toEqual({
      open: false,
      title: 'A',
    })
  })
})

describe('toggle markdown roundtrip', () => {
  it.each([
    ['> [!toggle]- **粗体** *斜体* [链接](https://example.com) `a*b` ![图示](image.png) $x^2$\n> body', '粗体 斜体 链接 a*b 图示 x^2'],
    ['> [!toggle] \\*字面\\* \\[方括号\\] C:\\\\path &amp; &lt;b&gt;\n> body', '*字面* [方括号] C:\\path & <b>'],
    ['> [!toggle]+ old\n> body', 'old'],
    ['> [!toggle]-无空格旧标题\n> body', '无空格旧标题'],
    ['> [!toggle]- **title\n> body** rest', 'title'],
  ])('imports old complex titles as one plain PM text node: %s', async (source, title) => {
    const f = await createToggleEditor(source)
    try {
      const node = f.view.state.doc.firstChild!
      expect(node.child(0).type.name).toBe('toggleTitle')
      expect(node.child(1).type.name).toBe('toggleBody')
      expect(node.child(0).textContent).toBe(title)
      expect(node.child(0).firstChild?.marks).toEqual([])
      const markdown = f.crepe.getMarkdown()
      expect(markdown).toContain('[!toggle]')
      expect(markdown).not.toContain('\\[!toggle]')
      expect(f.parse(markdown)!.eq(f.view.state.doc)).toBe(true)
      f.view.state.doc.check()
    } finally { await f.destroy() }
  })

  it('roundtrips newly edited literal punctuation and whitespace without title attr', async () => {
    const f = await createToggleEditor('')
    try {
      const title = '  **literal** [link](url) `code` $math$ \\ &amp; <tag> | ~~x~~ a  b\tend  '
      const node = createToggleNode(f.view.state.schema, title, undefined, { open: false })
      f.view.dispatch(f.view.state.tr.replaceWith(0, f.view.state.doc.content.size, node))
      // Crepe's trailing-node plugin adds an empty editor paragraph after edits;
      // Markdown intentionally does not persist that blank UI landing paragraph.
      expect(f.parse(f.crepe.getMarkdown())!.firstChild!.eq(node)).toBe(true)
      expect(f.view.state.schema.nodeFromJSON(f.view.state.doc.toJSON()).eq(f.view.state.doc)).toBe(true)
      const wrapper = document.createElement('div')
      wrapper.append(DOMSerializer.fromSchema(f.view.state.schema).serializeFragment(f.view.state.doc.content))
      expect(wrapper.querySelector('[data-title]')).toBeNull()
      expect(wrapper.querySelector('[data-toggle-title]')?.textContent).toBe(title)
      expect(DOMParser.fromSchema(f.view.state.schema).parse(wrapper).eq(f.view.state.doc)).toBe(true)
    } finally { await f.destroy() }
  })

  it('imports old copied HTML title once, retaining body marks and author default', async () => {
    const f = await createToggleEditor('')
    try {
      const old = document.createElement('div')
      old.innerHTML = '<div data-type="toggle" data-open="false" data-title="Old &amp; title"><div data-toggle-body><p><strong>body</strong></p></div></div>'
      const doc = DOMParser.fromSchema(f.view.state.schema).parse(old)
      doc.check()
      expect(doc.firstChild?.attrs.open).toBe(false)
      expect(doc.firstChild?.attrs.title).toBeUndefined()
      expect(doc.firstChild?.child(0).textContent).toBe('Old & title')
      expect(doc.firstChild?.child(1).firstChild?.firstChild?.marks[0].type.name).toBe('strong')
    } finally { await f.destroy() }
  })

  it('parses and serializes nested toggle, callout, table, list, code and inline marks', async () => {
    const f = await createToggleEditor('> [!toggle]- Outer\n>\n> > [!toggle]- Inner\n> >\n> > - **item**\n> >\n> > ```js\n> > code()\n> > ```\n>\n> > [!note] Callout\n> >\n> > body\n>\n> | A | B |\n> | - | - |\n> | x | y |')
    try {
      const names: string[] = []
      f.view.state.doc.descendants((node) => { names.push(node.type.name) })
      expect(names.filter((name) => name === 'toggle')).toHaveLength(2)
      expect(names).toEqual(expect.arrayContaining(['toggleTitle', 'toggleBody', 'callout', 'table', 'bullet_list', 'code_block']))
      expect(f.parse(f.crepe.getMarkdown())!.eq(f.view.state.doc)).toBe(true)
      f.view.state.doc.check()
    } finally { await f.destroy() }
  })
  it('preserves inline formatting immediately after the marker across roundtrips', async () => {
    const source = '> [!toggle]- 标题\n> **粗体**、*斜体*、[链接](https://example.com)、`代码`、![图片](image.png)\n'
    const first = await createToggleEditor(source)
    try {
      expect(first.root.querySelector('strong')?.textContent).toBe('粗体')
      expect(first.root.querySelector('em')?.textContent).toBe('斜体')
      expect(first.root.querySelector('a')?.getAttribute('href')).toBe('https://example.com')
      expect(first.root.querySelector('code')?.textContent).toBe('代码')
      expect(first.root.querySelector('img')?.getAttribute('src')).toBe('image.png')
      const markdown = first.editor.action(getMarkdown())
      const second = await createToggleEditor(markdown)
      try {
        expect(second.view.state.doc.toJSON()).toEqual(first.view.state.doc.toJSON())
        expect(normalizeMarkdown(second.editor.action(getMarkdown()))).toBe(normalizeMarkdown(markdown))
      } finally {
        await second.destroy()
      }
    } finally {
      await first.destroy()
    }
  })

  it('preserves collapsed open=false', async () => {
    const source = `> [!toggle]- 折叠标题
> 内容段落
`
    const { editor, view, destroy } = await createToggleEditor(source)
    try {
      let found = false
      view.state.doc.descendants((node) => {
        if (node.type.name === TOGGLE_TYPE) {
          found = true
          expect(node.attrs.open).toBe(false)
          expect(node.firstChild?.textContent).toBe('折叠标题')
          expect(node.attrs).not.toHaveProperty('title')
          expect(node.textContent).toContain('内容段落')
        }
      })
      expect(found).toBe(true)

      const out = editor.action(getMarkdown())
      expect(normalizeMarkdown(out)).toContain('[!toggle]- 折叠标题')
      expect(normalizeMarkdown(out)).toContain('内容段落')

      // 二次 roundtrip
      const again = await createToggleEditor(out)
      try {
        const out2 = again.editor.action(getMarkdown())
        expect(normalizeMarkdown(out2)).toBe(normalizeMarkdown(out))
      } finally {
        await again.destroy()
      }
    } finally {
      await destroy()
    }
  })

  it('preserves expanded open=true', async () => {
    const source = `> [!toggle] 展开标题
> hello
`
    const { editor, view, destroy } = await createToggleEditor(source)
    try {
      let open: boolean | undefined
      view.state.doc.descendants((node) => {
        if (node.type.name === TOGGLE_TYPE) {
          open = Boolean(node.attrs.open)
          expect(node.firstChild?.textContent).toBe('展开标题')
        }
      })
      expect(open).toBe(true)

      const out = editor.action(getMarkdown())
      expect(normalizeMarkdown(out)).toContain('[!toggle] 展开标题')
      expect(normalizeMarkdown(out)).not.toContain('[!toggle]-')
    } finally {
      await destroy()
    }
  })

  it('preserves nested block content', async () => {
    const source = `> [!toggle]- 外层
> 段落一
>
> - 列表项
>
> \`\`\`
> code
> \`\`\`
`
    const { editor, view, destroy } = await createToggleEditor(source)
    try {
      let toggleNode = null as null | { childCount: number; textContent: string }
      view.state.doc.descendants((node) => {
        if (node.type.name === TOGGLE_TYPE) {
          toggleNode = {
            childCount: node.childCount,
            textContent: node.textContent,
          }
        }
      })
      expect(toggleNode).not.toBeNull()
      expect(toggleNode!.childCount).toBeGreaterThanOrEqual(2)
      expect(toggleNode!.textContent).toContain('段落一')
      expect(toggleNode!.textContent).toContain('列表项')
      expect(toggleNode!.textContent).toContain('code')

      const out = editor.action(getMarkdown())
      expect(out).toContain('[!toggle]- 外层')
      expect(out).toContain('列表项')
      expect(out).toContain('code')
    } finally {
      await destroy()
    }
  })

  it('plain blockquote without marker stays blockquote', async () => {
    const source = `> just a quote
`
    const { view, destroy } = await createToggleEditor(source)
    try {
      let hasToggle = false
      let hasQuote = false
      view.state.doc.descendants((node) => {
        if (node.type.name === TOGGLE_TYPE) hasToggle = true
        if (node.type.name === 'blockquote') hasQuote = true
      })
      expect(hasToggle).toBe(false)
      expect(hasQuote).toBe(true)
    } finally {
      await destroy()
    }
  })
})
