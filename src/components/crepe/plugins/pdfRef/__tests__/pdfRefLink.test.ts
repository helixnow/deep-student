import { describe, expect, it, vi } from 'vitest';

import { handlePdfRefLinkClick } from '../click';
import { buildPdfRefHref, parsePdfRefHref } from '../protocol';
import { PDF_REF_EVENTS } from '../types';

describe('pdfref:// 协议（buildPdfRefHref / parsePdfRefHref）', () => {
  it('round-trips sourceId and page', () => {
    const href = buildPdfRefHref('tb_abc123', 42);
    expect(href).toBe('pdfref://tb_abc123?page=42');
    expect(parsePdfRefHref(href)).toEqual({ sourceId: 'tb_abc123', page: 42 });
  });

  it('percent-encodes exotic source ids and decodes them back', () => {
    const href = buildPdfRefHref('file id/怪', 3);
    expect(parsePdfRefHref(href)).toEqual({ sourceId: 'file id/怪', page: 3 });
  });

  it('rejects hrefs without a positive page', () => {
    expect(parsePdfRefHref('pdfref://tb_1')).toBeNull();
    expect(parsePdfRefHref('pdfref://tb_1?page=0')).toBeNull();
    expect(parsePdfRefHref('pdfref://tb_1?page=abc')).toBeNull();
    expect(parsePdfRefHref('pdfref://?page=3')).toBeNull();
  });

  it('rejects non-pdfref hrefs and empty input', () => {
    expect(parsePdfRefHref('note://note_1')).toBeNull();
    expect(parsePdfRefHref('https://example.com?page=3')).toBeNull();
    expect(parsePdfRefHref('')).toBeNull();
    expect(parsePdfRefHref(null)).toBeNull();
    expect(parsePdfRefHref(undefined)).toBeNull();
  });

  it('tolerates extra query params around page', () => {
    expect(parsePdfRefHref('pdfref://tb_1?foo=bar&page=7')).toEqual({
      sourceId: 'tb_1',
      page: 7,
    });
  });
});

describe('handlePdfRefLinkClick', () => {
  const makeView = (root: HTMLElement) =>
    ({ dom: root }) as unknown as import('@milkdown/prose/view').EditorView;

  it('dispatches pdf-ref:open for pdfref:// anchors', () => {
    const root = document.createElement('div');
    const a = document.createElement('a');
    a.setAttribute('href', 'pdfref://tb_99?page=12');
    a.textContent = '—— 摘自《x.pdf》第 12 页';
    root.appendChild(a);

    const events: CustomEvent[] = [];
    const onOpen = (e: Event) => {
      events.push(e as CustomEvent);
    };
    document.addEventListener(PDF_REF_EVENTS.OPEN_PDF_REF, onOpen);

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: a });
    const handled = handlePdfRefLinkClick(makeView(root), event);
    document.removeEventListener(PDF_REF_EVENTS.OPEN_PDF_REF, onOpen);

    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toEqual({ sourceId: 'tb_99', pageNumber: 12 });
  });

  it('resolves the anchor from nested click targets', () => {
    const root = document.createElement('div');
    const a = document.createElement('a');
    a.setAttribute('href', 'pdfref://file_7?page=2');
    const inner = document.createElement('strong');
    inner.textContent = '第 2 页';
    a.appendChild(inner);
    root.appendChild(a);

    const spy = vi.fn();
    document.addEventListener(PDF_REF_EVENTS.OPEN_PDF_REF, spy);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: inner });
    expect(handlePdfRefLinkClick(makeView(root), event)).toBe(true);
    document.removeEventListener(PDF_REF_EVENTS.OPEN_PDF_REF, spy);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('ignores note:// and external links (leaves them to other handlers)', () => {
    const root = document.createElement('div');
    const noteAnchor = document.createElement('a');
    noteAnchor.setAttribute('href', 'note://note_1');
    const webAnchor = document.createElement('a');
    webAnchor.setAttribute('href', 'https://example.com');
    root.append(noteAnchor, webAnchor);

    const spy = vi.fn();
    document.addEventListener(PDF_REF_EVENTS.OPEN_PDF_REF, spy);
    for (const anchor of [noteAnchor, webAnchor]) {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'target', { value: anchor });
      expect(handlePdfRefLinkClick(makeView(root), event)).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    }
    document.removeEventListener(PDF_REF_EVENTS.OPEN_PDF_REF, spy);
    expect(spy).not.toHaveBeenCalled();
  });

  it('ignores anchors outside the editor dom', () => {
    const root = document.createElement('div');
    const outside = document.createElement('a');
    outside.setAttribute('href', 'pdfref://tb_1?page=1');
    document.body.appendChild(outside);

    const spy = vi.fn();
    document.addEventListener(PDF_REF_EVENTS.OPEN_PDF_REF, spy);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: outside });
    expect(handlePdfRefLinkClick(makeView(root), event)).toBe(false);
    document.removeEventListener(PDF_REF_EVENTS.OPEN_PDF_REF, spy);
    outside.remove();
    expect(spy).not.toHaveBeenCalled();
  });
});
