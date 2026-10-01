/** Run via the dev UI bridge INSIDE the `npm run tauri dev` application:
 * await (await import('/tests/manual/wp11-columns-desktop.ts')).runColumnsDesktopAcceptance()
 * It mounts the real Crepe editor with the real plugin, uses no IPC mocks or note
 * writes, and destroys its temporary surface when finished. Never open a demo URL.
 */
import { Crepe } from '@milkdown/crepe'
import { columnsPlugin, columnsOpen } from '../../src/components/crepe/plugins/columns'

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`WP11 desktop acceptance: ${message}`)
}

export async function runColumnsDesktopAcceptance() {
  assert('__TAURI_INTERNALS__' in window, 'run inside the real Tauri desktop app')
  const surface = document.createElement('section')
  surface.setAttribute('data-wp11-acceptance', '')
  Object.assign(surface.style, {
    position: 'fixed', inset: '60px auto auto 20px', width: '1100px',
    maxHeight: '85vh', overflowY: 'auto', zIndex: '2147483000',
    background: 'var(--background, white)', color: 'var(--foreground, black)',
  })
  const root = document.createElement('div')
  surface.append(root)
  document.body.append(surface)
  const cells = Array.from({ length: 12 }, (_, i) => `Column ${i}`)
  const table = `| ${cells.join(' | ')} |\n| ${cells.map(() => '---').join(' | ')} |\n| ${cells.map(() => 'wide-unbroken-value-0123456789').join(' | ')} |`
  const source = `${columnsOpen('cornell')}\n\n:::column\n\n## Cues\n\nLeft-first\n\n:::end-column\n\n:::column\n\n## Notes\n\nRight-second\n\n${table}\n\n:::end-column\n\n:::end-ds-columns\n\n## Summary\n\nSummary-third\n`
  const crepe = new Crepe({ root, defaultValue: source })
  crepe.editor.use(columnsPlugin({ canWrite: () => true }))
  try {
    await crepe.create()
    const results: Record<string, unknown>[] = []
    for (const width of [1100, 390]) {
      surface.style.width = `${width}px`
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      const editor = root.querySelector<HTMLElement>('.ProseMirror')!
      const columns = [...root.querySelectorAll<HTMLElement>('[data-ds-column]')]
      assert(columns.length === 2, 'two schema columns')
      const [left, right] = columns.map((node) => node.getBoundingClientRect())
      const summary = [...editor.querySelectorAll('h2')].find((node) => node.textContent === 'Summary')!.getBoundingClientRect()
      if (width === 390 || window.innerWidth <= 767) {
        assert(right.top >= left.bottom, 'narrow reading order: left before right')
        assert(Math.abs(right.left - left.left) < 2, 'narrow columns align to one track')
      } else {
        assert(Math.abs(left.top - right.top) < 2, 'desktop columns share the same row')
        assert(right.width > left.width * 1.7, 'Cornell notes column is wider than cues')
      }
      assert(summary.top >= Math.max(left.bottom, right.bottom), 'summary follows both columns')
      assert(editor.scrollWidth <= editor.clientWidth + 2, 'wide table does not widen the editor')
      const scroller = [...columns[1].querySelectorAll<HTMLElement>('*')].find((node) =>
        ['auto', 'scroll'].includes(getComputedStyle(node).overflowX) && node.scrollWidth > node.clientWidth + 5)
      assert(scroller, 'wide table has a local horizontal scroller')
      scroller.scrollLeft = 80
      assert(scroller.scrollLeft > 0, 'table really scrolls horizontally')
      const text = editor.textContent ?? ''
      assert(text.indexOf('Left-first') < text.indexOf('Right-second') && text.indexOf('Right-second') < text.indexOf('Summary-third'), 'DOM reading order')
      results.push({ width, viewport: window.innerWidth, left: { x: left.x, y: left.y, width: left.width, height: left.height },
        right: { x: right.x, y: right.y, width: right.width, height: right.height },
        editorWidth: editor.clientWidth, editorScrollWidth: editor.scrollWidth,
        tableClientWidth: scroller.clientWidth, tableScrollWidth: scroller.scrollWidth, tableScrollLeft: scroller.scrollLeft })
    }
    return { passed: true, results }
  } finally {
    await crepe.destroy()
    surface.remove()
  }
}
