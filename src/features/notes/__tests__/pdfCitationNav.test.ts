import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearRememberedNoteScrollPosition,
  dispatchPdfCitationNavigation,
  getRememberedNoteScrollPosition,
  isPdfCitationHref,
  parsePdfCitationHref,
  parsePdfLocatorParams,
  rememberNoteScrollPosition,
} from '../pdfCitationNav';
import {
  navigateToNoteOrigin,
  parseNoteOrigin,
  serializeNoteOrigin,
} from '../noteOrigin';

describe('pdfCitationNav precision parsing and dispatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearRememberedNoteScrollPosition();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearRememberedNoteScrollPosition();
  });

  it('parses pdfref links preserving exact pageNumber, highlightId/annotationId, and quote', () => {
    expect(parsePdfCitationHref('pdfref://tb_42?page=17&highlight=hl_99&quote=Bayes%20theorem')).toEqual({
      sourceId: 'tb_42',
      pageNumber: 17,
      highlightId: 'hl_99',
      quote: 'Bayes theorem',
      locator: undefined,
    });

    expect(parsePdfCitationHref('pdfref:///tb_42?p=9&annotationId=ann_7')).toEqual({
      sourceId: 'tb_42',
      pageNumber: 9,
      highlightId: 'ann_7',
      quote: undefined,
      locator: undefined,
    });

    expect(parsePdfCitationHref('pdfref://tb_42#page=23&highlightId=hl_23')).toEqual({
      sourceId: 'tb_42',
      pageNumber: 23,
      highlightId: 'hl_23',
      quote: undefined,
      locator: undefined,
    });

    expect(parsePdfCitationHref('pdfref://tb_42?page=11#hl_bare')).toEqual({
      sourceId: 'tb_42',
      pageNumber: 11,
      highlightId: 'hl_bare',
      quote: undefined,
      locator: undefined,
    });
  });

  it('never coerces invalid or missing pages to page 1', () => {
    expect(parsePdfCitationHref('pdfref://tb_42?page=0&highlight=hl_1')?.pageNumber).toBeUndefined();
    expect(parsePdfCitationHref('pdfref://tb_42?page=-2')?.pageNumber).toBeUndefined();
    expect(parsePdfCitationHref('pdfref://tb_42?page=abc')?.pageNumber).toBeUndefined();
    expect(isPdfCitationHref('ds-anchor://v1/pdf/tb_42?page=5&annotationId=ann_1')).toBe(true);
    expect(isPdfCitationHref('https://example.com')).toBe(false);
  });

  it('extracts page and highlightId from compound locators', () => {
    expect(parsePdfLocatorParams('page:14#highlight:hl_77')).toEqual({
      pageNumber: 14,
      highlightId: 'hl_77',
    });
    expect(parsePdfLocatorParams('p.8&annotationId=ann_12')).toEqual({
      pageNumber: 8,
      highlightId: 'ann_12',
    });
  });

  it('dispatches pdf-ref:open and retries pdf-ref:focus until acknowledged', () => {
    const openEvents: Array<Record<string, unknown>> = [];
    const focusEvents: Array<Record<string, unknown>> = [];
    const onOpen = (e: Event) => openEvents.push((e as CustomEvent).detail);
    const onFocus = (e: Event) => {
      const detail = (e as CustomEvent).detail as Record<string, unknown> & {
        acknowledge?: (ok: boolean) => void;
      };
      focusEvents.push(detail);
      if (focusEvents.length === 2) {
        detail.acknowledge?.(true);
      }
    };

    document.addEventListener('pdf-ref:open', onOpen);
    document.addEventListener('pdf-ref:focus', onFocus);

    const cancel = dispatchPdfCitationNavigation(
      { sourceId: 'pdf_1', pageNumber: 12, highlightId: 'hl_12', quote: 'important lemma' },
      { sourceWindowId: 'win_notes_1', retryDelaysMs: [0, 200, 600, 1200] },
    );

    expect(openEvents).toHaveLength(1);
    expect(openEvents[0]).toMatchObject({
      sourceId: 'pdf_1',
      path: '/pdf_1',
      pageNumber: 12,
      highlightId: 'hl_12',
      annotationId: 'hl_12',
      quote: 'important lemma',
      sourceWindowId: 'win_notes_1',
    });
    expect(focusEvents).toHaveLength(1);

    vi.advanceTimersByTime(200);
    expect(focusEvents).toHaveLength(2);
    expect(focusEvents[1]).toMatchObject({
      sourceId: 'pdf_1',
      pageNumber: 12,
      highlightId: 'hl_12',
      annotationId: 'hl_12',
      sourceWindowId: 'win_notes_1',
    });

    // Acknowledged on attempt 2 -> subsequent retries must NOT fire.
    vi.advanceTimersByTime(5000);
    expect(focusEvents).toHaveLength(2);

    cancel();
    document.removeEventListener('pdf-ref:open', onOpen);
    document.removeEventListener('pdf-ref:focus', onFocus);
  });

  it('marks superseded focus requests stale when a newer citation click arrives', () => {
    const received: Array<{ pageNumber?: number; isStale?: () => boolean }> = [];
    const onFocus = (e: Event) => {
      received.push((e as CustomEvent).detail);
    };
    document.addEventListener('pdf-ref:focus', onFocus);

    dispatchPdfCitationNavigation(
      { sourceId: 'pdf_2', pageNumber: 5 },
      { retryDelaysMs: [0, 300] },
    );
    expect(received[0]?.isStale?.()).toBe(false);

    dispatchPdfCitationNavigation(
      { sourceId: 'pdf_2', pageNumber: 19, highlightId: 'hl_19' },
      { retryDelaysMs: [0, 300] },
    );
    expect(received[0]?.isStale?.()).toBe(true);
    expect(received[1]?.pageNumber).toBe(19);
    expect(received[1]?.isStale?.()).toBe(false);

    vi.advanceTimersByTime(300);
    // Only the newer citation retries; the superseded page 5 timer was cancelled.
    expect(received.map((item) => item.pageNumber)).toEqual([5, 19, 19]);

    document.removeEventListener('pdf-ref:focus', onFocus);
  });

  it('round-trips highlightId in NoteOrigin and preserves locator page/highlight during navigateToNoteOrigin', async () => {
    const origin = {
      kind: 'resource' as const,
      resourceId: 'file_pdf',
      page: 14,
      highlightId: 'hl_14',
      locator: 'page:14#highlight:hl_14',
      title: '概率论讲义',
      quote: '条件期望',
    };
    expect(parseNoteOrigin(serializeNoteOrigin(origin))).toEqual(origin);

    const openEvents: Array<Record<string, unknown>> = [];
    const focusEvents: Array<Record<string, unknown>> = [];
    const onOpen = (e: Event) => openEvents.push((e as CustomEvent).detail);
    const onFocus = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      focusEvents.push(detail);
      detail.acknowledge?.(true);
    };
    document.addEventListener('pdf-ref:open', onOpen);
    document.addEventListener('pdf-ref:focus', onFocus);

    // Even when `page` is omitted and encoded only inside `locator`, it must resolve exact page & highlightId.
    await navigateToNoteOrigin(
      { kind: 'resource', resourceId: 'file_pdf', locator: 'page:14#highlight:hl_14', quote: '条件期望' },
      { sourceWindowId: 'win_notes_2' },
    );

    expect(openEvents[0]).toMatchObject({
      sourceId: 'file_pdf',
      pageNumber: 14,
      highlightId: 'hl_14',
      annotationId: 'hl_14',
      sourceWindowId: 'win_notes_2',
    });
    expect(focusEvents[0]).toMatchObject({
      sourceId: 'file_pdf',
      pageNumber: 14,
      highlightId: 'hl_14',
    });

    document.removeEventListener('pdf-ref:open', onOpen);
    document.removeEventListener('pdf-ref:focus', onFocus);
  });

  it('stores and retrieves per-note scroll positions safely', () => {
    rememberNoteScrollPosition('note_1', 428.6);
    expect(getRememberedNoteScrollPosition('note_1')).toBe(429);

    rememberNoteScrollPosition('note_1', -10);
    expect(getRememberedNoteScrollPosition('note_1')).toBe(429);

    rememberNoteScrollPosition('note_1', Number.NaN);
    expect(getRememberedNoteScrollPosition('note_1')).toBe(429);

    clearRememberedNoteScrollPosition('note_1');
    expect(getRememberedNoteScrollPosition('note_1')).toBeUndefined();
  });
});
