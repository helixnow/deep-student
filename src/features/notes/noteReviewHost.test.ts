import { afterEach, describe, expect, it, vi } from 'vitest';
import { Crepe } from '@milkdown/crepe';
import { editorViewCtx } from '@milkdown/kit/core';
import { TextSelection, NodeSelection } from '@milkdown/prose/state';
import { resolveNoteReviewScope, saveReviewAs } from './noteReviewHost';
import type { FullDocumentSearchApi } from './fullDocument';
import { invoke } from '@tauri-apps/api/core';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const destroys: Array<() => Promise<void>> = [];
afterEach(async () => { for (const destroy of destroys.splice(0)) await destroy(); vi.clearAllMocks(); });
async function host(markdown: string, tail = '') {
  const root = document.createElement('div'); document.body.appendChild(root);
  const crepe = new Crepe({ root, defaultValue: markdown }); await crepe.create();
  destroys.push(async () => { await crepe.destroy(); root.remove(); });
  const view = crepe.editor.ctx.get(editorViewCtx);
  const api = { getCrepe: () => crepe, isDocumentWindowed: () => !!tail,
    getFullDocument: () => ({ noteId: 'scope', revision: 1, markdown: crepe.getMarkdown() + tail }),
  } as FullDocumentSearchApi;
  function select(text: string) {
    let start = -1;
    view.state.doc.descendants((node, pos) => { if (node.isText && node.text?.includes(text)) start = pos + node.text.indexOf(text); });
    expect(start).toBeGreaterThanOrEqual(0);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start, start + text.length)));
  }
  const scopeText = (kind: Parameters<typeof resolveNoteReviewScope>[1]) => {
    const scope = resolveNoteReviewScope(api, kind);
    return scope.baseline.markdown.slice(scope.from, scope.to);
  };
  return { view, api, select, scopeText };
}
describe('real editor review scopes', () => {
  it('maps a UTF-16 selection after emoji and across escaping without changing the live doc', async () => {
    const h = await host('# Title\n\n😀 alpha *literal* and \\*star\\* tail\n');
    h.select('alpha');
    const before = h.view.state;
    expect(h.scopeText('selection')).toBe('alpha');
    expect(h.view.state).toBe(before);
    h.select('*star*');
    expect(h.scopeText('selection')).toBe('\\*star\\*');
  });
  it('preserves inline mark boundaries and returns complete blocks/sections', async () => {
    const h = await host('# Top\n\nIntro\n\n## Part\n\n**bold** and [link](https://example.com)\n\n### Child\n\nNested\n\n## Next\n\nEnd\n');
    h.select('bold');
    expect(h.scopeText('selection')).toBe('bold');
    expect(h.scopeText('block').trim()).toBe('**bold** and [link](https://example.com)');
    expect(h.scopeText('section').trim()).toBe('## Part\n\n**bold** and [link](https://example.com)\n\n### Child\n\nNested');
    h.select('link'); expect(h.scopeText('selection')).toBe('link');
  });
  it('includes the unloaded suffix for page and heading section scopes', async () => {
    const h = await host('# First\n\nVisible\n', '\nHidden tail\n\n# Next\n\nEnd\n');
    h.select('Visible');
    expect(h.scopeText('section')).toContain('Hidden tail');
    expect(h.scopeText('section')).not.toContain('# Next');
    expect(h.scopeText('page')).toContain('End');
    h.view.dispatch(h.view.state.tr.setSelection(NodeSelection.create(h.view.state.doc, 0)));
    expect(h.scopeText('block').trim()).toBe('# First');
  });
});
it('uses the backend save-as operation and the confirmed OCC token for later groups', async () => {
  vi.mocked(invoke).mockResolvedValueOnce({ noteId: 'copy', revision: 1, markdown: 'one', updatedAt: 'token1' })
    .mockResolvedValueOnce({ noteId: 'copy', revision: 2, markdown: 'two', updatedAt: 'token2' });
  const saved = await saveReviewAs('one', 'op-save-as', 'source', 'title');
  await saveReviewAs('two', 'op-save-as', 'source', 'title', saved);
  expect(invoke).toHaveBeenLastCalledWith('notes_review_save_as', { operationId: 'op-save-as', sourceNoteId: 'source', markdown: 'two', expectedUpdatedAt: 'token1', capabilities: ['ds-columns-v1'] });
});
