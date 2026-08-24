import { describe, expect, it } from 'vitest';

import {
  buildSelectionLocator,
  buildSelectionNoteContent,
  formatSelectionQuoteBlock,
  resolveSelectionMenuFrame,
} from '../pdfSelectionActions';

describe('buildSelectionLocator', () => {
  it('emits the page:N locator convention', () => {
    expect(buildSelectionLocator(3)).toBe('page:3');
  });
});

describe('formatSelectionQuoteBlock', () => {
  it('quotes single-line text', () => {
    expect(formatSelectionQuoteBlock('  hello world ')).toBe('> hello world');
  });

  it('quotes every line of multi-line text', () => {
    expect(formatSelectionQuoteBlock('first\nsecond')).toBe('> first\n> second');
  });
});

describe('buildSelectionNoteContent', () => {
  it('combines quote block and source label', () => {
    expect(
      buildSelectionNoteContent({ text: 'important idea', sourceLabel: '来源：《a.pdf》第 2 页' }),
    ).toBe('> important idea\n\n来源：《a.pdf》第 2 页\n');
  });
});

describe('resolveSelectionMenuFrame', () => {
  const viewport = { width: 1000, height: 800 };
  const menu = { width: 200, height: 80 };

  it('centers above the anchor when there is room', () => {
    const frame = resolveSelectionMenuFrame(
      { x: 500, top: 300, bottom: 320 },
      menu,
      viewport,
    );
    expect(frame).toEqual({ left: 400, top: 210, placement: 'above' });
  });

  it('flips below the anchor when the menu would overflow the top edge', () => {
    const frame = resolveSelectionMenuFrame(
      { x: 500, top: 40, bottom: 60 },
      menu,
      viewport,
    );
    expect(frame.placement).toBe('below');
    expect(frame.top).toBe(70);
  });

  it('clamps horizontally at both edges', () => {
    expect(
      resolveSelectionMenuFrame({ x: 10, top: 300, bottom: 320 }, menu, viewport).left,
    ).toBe(8);
    expect(
      resolveSelectionMenuFrame({ x: 995, top: 300, bottom: 320 }, menu, viewport).left,
    ).toBe(1000 - 8 - 200);
  });

  it('keeps the flipped menu inside the bottom edge', () => {
    const frame = resolveSelectionMenuFrame(
      { x: 500, top: 20, bottom: 790 },
      menu,
      viewport,
    );
    expect(frame.placement).toBe('below');
    expect(frame.top).toBe(800 - 8 - 80);
  });

  it('clamps an above placement when a stale anchor is below the viewport', () => {
    const frame = resolveSelectionMenuFrame(
      { x: 500, top: 950, bottom: 970 },
      menu,
      viewport,
    );
    expect(frame.placement).toBe('above');
    expect(frame.top).toBe(800 - 8 - 80);
  });

  it('never returns coordinates above the margin even for tiny viewports', () => {
    const frame = resolveSelectionMenuFrame(
      { x: 50, top: 4, bottom: 6 },
      { width: 300, height: 200 },
      { width: 200, height: 100 },
    );
    expect(frame.left).toBe(8);
    expect(frame.top).toBe(8);
  });
});
