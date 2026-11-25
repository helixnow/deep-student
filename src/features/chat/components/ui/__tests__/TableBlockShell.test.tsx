import React from 'react';
import katex from 'katex';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/lazyStyles', () => ({
  ensureKatexStyles: vi.fn(),
}));

vi.mock('@/features/chat/components/renderers/lazyKatex', () => ({
  getLoadedKatex: () => katex,
  ensureKatexLoaded: vi.fn(async () => katex),
  scheduleKatexIdlePrefetch: vi.fn(),
}));

import { TableBlockShell, syncHorizontalScrollCue } from '../TableBlockShell';
import { MarkdownRenderer } from '../../renderers/MarkdownRenderer';

function defineScrollGeometry(
  el: HTMLElement,
  geometry: { scrollWidth: number; clientWidth: number; scrollLeft?: number },
): void {
  Object.defineProperty(el, 'scrollWidth', {
    configurable: true,
    value: geometry.scrollWidth,
  });
  Object.defineProperty(el, 'clientWidth', {
    configurable: true,
    value: geometry.clientWidth,
  });
  let scrollLeftValue = geometry.scrollLeft ?? 0;
  Object.defineProperty(el, 'scrollLeft', {
    configurable: true,
    get: () => scrollLeftValue,
    set: (next: number) => {
      scrollLeftValue = next;
    },
  });
}

describe('TableBlockShell & MathScrollShell native horizontal scroll', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders TableBlockShell with a lightweight native horizontal scroll container (no OverlayScrollbars)', () => {
    const columns = Array.from({ length: 10 }, (_, idx) => `Col ${idx + 1}`);
    const { container } = render(
      <TableBlockShell>
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col}>{col}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            {columns.map((col) => (
              <td key={col}>{`${col} long cell payload`}</td>
            ))}
          </tr>
        </tbody>
      </TableBlockShell>,
    );

    const wrapper = container.querySelector('.table-wrapper') as HTMLElement | null;
    const scroller = container.querySelector('.table-scroll-area') as HTMLElement | null;
    const table = scroller?.querySelector('table.markdown-table');

    expect(wrapper).not.toBeNull();
    expect(scroller).not.toBeNull();
    expect(table).not.toBeNull();
    expect(scroller?.getAttribute('data-orientation')).toBe('horizontal');
    expect(scroller?.getAttribute('data-native-scrollbars')).toBe('true');
    expect(scroller?.className).toContain('overflow-x-auto');
    expect(scroller?.className).toContain('overflow-y-hidden');
    expect(scroller?.className).toContain('min-w-0');
    expect(container.querySelector('[data-overlayscrollbars]')).toBeNull();
    expect(container.querySelector('[data-overlayscrollbars-initialize]')).toBeNull();
    expect(table?.querySelectorAll('thead th')).toHaveLength(10);
  });

  it('tracks left and right horizontal scroll overflow cues on TableBlockShell as the user scrolls', () => {
    const { container } = render(
      <TableBlockShell>
        <thead>
          <tr>
            <th>Header A</th>
            <th>Header B</th>
          </tr>
        </thead>
      </TableBlockShell>,
    );

    const wrapper = container.querySelector('.table-wrapper') as HTMLElement;
    const scroller = container.querySelector('.table-scroll-area') as HTMLElement;

    // Wide table overflowing container on the right
    defineScrollGeometry(scroller, { scrollWidth: 1200, clientWidth: 460, scrollLeft: 0 });
    syncHorizontalScrollCue(wrapper, scroller);
    expect(wrapper.getAttribute('data-scroll-overflow-right')).toBe('true');
    expect(wrapper.hasAttribute('data-scroll-overflow-left')).toBe(false);

    // Mid-scroll shows both left and right cues
    scroller.scrollLeft = 300;
    fireEvent.scroll(scroller);
    syncHorizontalScrollCue(wrapper, scroller);
    expect(wrapper.getAttribute('data-scroll-overflow-left')).toBe('true');
    expect(wrapper.getAttribute('data-scroll-overflow-right')).toBe('true');

    // Reached right end clears right cue while retaining left cue
    scroller.scrollLeft = 740;
    syncHorizontalScrollCue(wrapper, scroller);
    expect(wrapper.getAttribute('data-scroll-overflow-left')).toBe('true');
    expect(wrapper.hasAttribute('data-scroll-overflow-right')).toBe(false);

    // Fits without overflow clears both cues
    defineScrollGeometry(scroller, { scrollWidth: 460, clientWidth: 460, scrollLeft: 0 });
    syncHorizontalScrollCue(wrapper, scroller);
    expect(wrapper.hasAttribute('data-scroll-overflow-left')).toBe(false);
    expect(wrapper.hasAttribute('data-scroll-overflow-right')).toBe(false);
  });

  it('renders block KaTeX inside a lightweight native MathScrollShell without OverlayScrollbars', () => {
    const wideMatrix = [
      '$$',
      'M = \\begin{bmatrix} a_{11} & a_{12} & a_{13} & a_{14} & a_{15} & a_{16} \\\\ b_{21} & b_{22} & b_{23} & b_{24} & b_{25} & b_{26} \\end{bmatrix}',
      '$$',
    ].join('\n');

    const { container } = render(<MarkdownRenderer content={wideMatrix} />);

    const wrapper = container.querySelector('.math-scroll-wrapper') as HTMLElement | null;
    const scroller = wrapper?.querySelector('.math-scroll-area') as HTMLElement | null;

    expect(wrapper).not.toBeNull();
    expect(scroller).not.toBeNull();
    expect(scroller?.getAttribute('data-orientation')).toBe('horizontal');
    expect(scroller?.getAttribute('data-native-scrollbars')).toBe('true');
    expect(scroller?.className).toContain('overflow-x-auto');
    expect(scroller?.className).toContain('overflow-y-hidden');
    expect(scroller?.className).toContain('min-w-0');
    expect(scroller?.querySelector('.katex-display')).not.toBeNull();
    expect(container.querySelector('[data-overlayscrollbars]')).toBeNull();
    expect(container.querySelector('[data-overlayscrollbars-initialize]')).toBeNull();

    defineScrollGeometry(scroller!, { scrollWidth: 960, clientWidth: 420, scrollLeft: 0 });
    syncHorizontalScrollCue(wrapper, scroller);
    expect(wrapper?.getAttribute('data-scroll-overflow-right')).toBe('true');
  });
});
