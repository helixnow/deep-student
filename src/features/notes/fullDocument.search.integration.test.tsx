import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Crepe } from '@milkdown/crepe';
import { editorViewCtx } from '@milkdown/kit/core';
import { undo, redo, undoDepth } from '@milkdown/prose/history';
import { createFullDocumentApi, type FullDocumentViewHost } from './fullDocument';
import { FindReplacePanel } from './components/FindReplacePanel';
import { searchHighlightPlugin, collectSearchMatches, replaceAllSearchMatches } from '@/components/crepe/plugins/searchHighlight';
import { togglePlugin } from '@/components/crepe/plugins/toggle';
import { installSearchWorkerHarness } from '@/components/crepe/plugins/__tests__/searchWorkerTestHarness';

vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
}) }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));

const destroys: Array<() => Promise<void>> = [];
beforeEach(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => { cleanup(); for (const destroy of destroys.splice(0)) await destroy(); });

async function createHost(prefix: string, tail = '') {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const crepe = new Crepe({ root, defaultValue: prefix });
  crepe.editor.use(searchHighlightPlugin).use(togglePlugin());
  await crepe.create();
  const view = crepe.editor.ctx.get(editorViewCtx);
  let windowed = !!tail;
  let revision = 0;
  let projecting = false;
  let dirty = false;
  const originalDispatch = view.dispatch.bind(view);
  view.dispatch = (tr) => {
    if (tr.docChanged && !projecting) { revision++; dirty = true; }
    originalDispatch(tr);
  };
  const save = vi.fn(async () => { dirty = false; });
  const base = {
    getCrepe: () => crepe,
    getMarkdown: () => crepe.getMarkdown(),
    getFullMarkdown: () => crepe.getMarkdown() + (windowed ? tail : ''),
    isReadonly: () => crepe.readonly,
    isDocumentWindowed: () => windowed,
    acceptFullDocumentView: () => { windowed = false; },
    flushPendingSave: save,
  } as unknown as FullDocumentViewHost;
  const api = createFullDocumentApi(base, {
    noteId: 'real-crepe', isCurrent: () => true, revision: () => revision,
    isWindowed: () => windowed, retainFailure: vi.fn(),
    projectView: (apply) => { projecting = true; try { apply(); } finally { projecting = false; } },
  });
  destroys.push(async () => { await crepe.destroy(); root.remove(); });
  return { api, view, crepe, root, save, get dirty() { return dirty; } };
}

describe('full draft search with real Crepe and real worker', () => {
  it('finds a library query in a 1400-paragraph tail, materializes without dirty/history and atomically replaces/undoes', async () => {
    const tail = '\n' + Array.from({ length: 1400 }, (_, i) => `paragraph ${i}\n`).join('\n') + '\nTAIL-NEEDLE\n\nNever truncate END\n';
    const host = await createHost('prefix NEEDLE\n', tail);
    const selection = host.view.state.selection;
    const depth = undoDepth(host.view.state);
    Object.defineProperties(host.root, { scrollHeight: { value: 9000 }, clientHeight: { value: 500 } });
    host.root.scrollTop = 73;
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      host.root.scrollTop = this.closest('p')?.textContent?.includes('TAIL') ? 8000 : 0;
    });
    const mounted = render(<FindReplacePanel editorApi={host.api} onClose={vi.fn()} initialQuery="NEEDLE" />);
    await screen.findByText('1/2');
    expect(host.api.isDocumentWindowed!()).toBe(false);
    expect(host.dirty).toBe(false);
    expect(host.save).not.toHaveBeenCalled();
    expect(undoDepth(host.view.state)).toBe(depth);
    expect(host.view.state.selection.eq(selection)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'notes:findReplace.next' }));
    expect(screen.getByText('2/2')).toBeTruthy();
    expect(host.root.querySelector('.notes-search-match--active')?.closest('p')?.textContent).toBe('TAIL-NEEDLE');
    expect(scroll).toHaveBeenCalled();
    expect(host.root.scrollTop).toBe(8000);
    fireEvent.click(screen.getByRole('button', { name: 'notes:findReplace.showReplace' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'notes:findReplace.replaceLabel' }), { target: { value: '**literal**' } });
    fireEvent.click(screen.getByRole('button', { name: 'notes:findReplace.replace' }));
    await waitFor(() => expect(host.save).toHaveBeenCalledTimes(1));
    expect(host.view.state.doc.textContent).toContain('TAIL-**literal**');
    expect(host.view.state.doc.lastChild?.textContent).toBe('Never truncate END');
    act(() => { expect(undo(host.view.state, host.view.dispatch)).toBe(true); });
    await waitFor(() => expect(screen.getByRole('search')).toHaveAttribute('aria-busy', 'false'));
    expect(host.view.state.doc.textContent).toContain('TAIL-NEEDLE');
    fireEvent.click(screen.getByRole('button', { name: 'notes:findReplace.replaceAll' }));
    await waitFor(() => expect(host.save).toHaveBeenCalledTimes(2));
    expect(collectSearchMatches(host.view.state.doc, 'NEEDLE')).toHaveLength(0);
    act(() => { expect(undo(host.view.state, host.view.dispatch)).toBe(true); });
    expect(collectSearchMatches(host.view.state.doc, 'NEEDLE')).toHaveLength(2);
    expect(host.view.state.doc.lastChild?.textContent).toBe('Never truncate END');
    act(() => { expect(redo(host.view.state, host.view.dispatch)).toBe(true); });
    expect(collectSearchMatches(host.view.state.doc, '**literal**')).toHaveLength(2);
    mounted.unmount();
    expect(host.root.scrollTop).toBe(73);
  }, 15000);

  it('retains unsaved prefix undo, marks, link targets and rejects a stale revision', async () => {
    const host = await createHost('he**ll***o* [link](https://example.com)\n', '\nTAIL\n');
    host.view.dispatch(host.view.state.tr.insertText('draft ', 1));
    await host.api.materializeFullDocument();
    const baseline = host.api.getFullDocument();
    const matches = collectSearchMatches(host.view.state.doc, 'hello');
    await host.api.applyFullDocumentTransaction(replaceAllSearchMatches(host.view.state.tr, matches, 'world'), baseline);
    const paragraph = host.view.state.doc.firstChild!;
    expect(paragraph.child(1).text).toBe('rl');
    expect(paragraph.child(1).marks[0].type.name).toBe('strong');
    expect(host.crepe.getMarkdown()).toContain('https://example.com');
    expect(collectSearchMatches(host.view.state.doc, '**')).toHaveLength(0);
    const staleTr = replaceAllSearchMatches(host.view.state.tr, collectSearchMatches(host.view.state.doc, 'world'), 'stale');
    await expect(host.api.applyFullDocumentTransaction(staleTr, baseline)).rejects.toThrow();
    expect(undo(host.view.state, host.view.dispatch)).toBe(true);
    expect(host.view.state.doc.textContent).toContain('draft hello');
    expect(undo(host.view.state, host.view.dispatch)).toBe(true);
    expect(host.view.state.doc.textContent).not.toContain('draft');
    expect(host.view.state.doc.lastChild?.textContent).toBe('TAIL');
  });

  it('reveals a folded hit locally and restores folds on exit in read-only mode', async () => {
    const host = await createHost('> [!toggle]- Fold\n> hidden needle\n');
    host.crepe.setReadonly(true);
    const before = host.crepe.getMarkdown();
    const depth = undoDepth(host.view.state);
    const mounted = render(<FindReplacePanel editorApi={host.api} readOnly onClose={vi.fn()} initialQuery="needle" />);
    await screen.findByText('1/1');
    expect(host.root.querySelector('.milkdown-toggle')).toHaveAttribute('data-view-open', 'true');
    expect(screen.queryByRole('button', { name: 'notes:findReplace.showReplace' })).toBeNull();
    expect(host.crepe.getMarkdown()).toBe(before);
    expect(undoDepth(host.view.state)).toBe(depth);
    mounted.unmount();
    expect(host.root.querySelector('.milkdown-toggle')).toHaveAttribute('data-view-open', 'false');
    expect(host.dirty).toBe(false);
  });

  it('shows invalid regex, cancels a real catastrophic worker and can search again', async () => {
    const host = await createHost('a'.repeat(40000) + '!\n');
    const harness = installSearchWorkerHarness();
    try {
      render(<FindReplacePanel editorApi={host.api} onClose={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: '使用正则表达式' }));
      const input = screen.getByRole('textbox', { name: 'notes:findReplace.findLabel' });
      fireEvent.change(input, { target: { value: '([' } });
      expect(input).toHaveAttribute('aria-invalid', 'true');
      fireEvent.change(input, { target: { value: '(a+)+$' } });
      expect(screen.getByRole('search')).toHaveAttribute('aria-busy', 'true');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
      fireEvent.click(screen.getByRole('button', { name: '取消' }));
      expect(screen.getByRole('search')).toHaveAttribute('aria-busy', 'false');
      expect(harness.terminated).toBeGreaterThan(0);
      fireEvent.change(input, { target: { value: '!$' } });
      await screen.findByText('1/1');
      expect(host.dirty).toBe(false);
      expect(undoDepth(host.view.state)).toBe(0);
    } finally { cleanup(); harness.cleanup(); }
  });

  it('cancels pending full materialization without touching the view', async () => {
    const host = await createHost('prefix', '\nTAIL');
    const original = host.view.state.doc;
    const controller = new AbortController();
    const pending = host.api.materializeFullDocument(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(host.view.state.doc).toBe(original);
    expect(host.api.isDocumentWindowed!()).toBe(true);
    expect(host.dirty).toBe(false);
  });
});
