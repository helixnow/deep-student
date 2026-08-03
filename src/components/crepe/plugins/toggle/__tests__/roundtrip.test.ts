import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from '@milkdown/core'
import { commonmark } from '@milkdown/preset-commonmark'
import { getMarkdown } from '@milkdown/utils'
import { describe, expect, it } from 'vitest'

import {
  formatToggleMarker,
  parseToggleMarker,
  TOGGLE_TYPE,
  togglePlugin,
} from '../index'

function normalizeMarkdown(md: string): string {
  return md.replace(/\r\n/g, '\n').replace(/\n+$/, '\n').trimEnd() + '\n'
}

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
          expect(node.attrs.title).toBe('折叠标题')
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
          expect(node.attrs.title).toBe('展开标题')
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
