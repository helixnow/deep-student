import React, { useRef } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import {
  SelectionToolbar,
  computeSelectionToolbarPosition,
} from '../SelectionToolbar';

vi.mock('@/stores/viewStore', () => ({
  useViewStore: (selector: (s: { currentView: string }) => unknown) =>
    selector({ currentView: 'workbench' }),
}));

vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
}));

describe('Gap S3: 460px split-pane PDF container ergonomics & SelectionToolbar clamping', () => {
  afterEach(() => {
    cleanup();
  });

  it('clamps computeSelectionToolbarPosition within narrow containerBounds narrower than window.innerWidth', () => {
    // 460px left split pane on a 1440px desktop viewport, selection near right edge of the left pane
    const leftPanePos = computeSelectionToolbarPosition(
      { top: 200, left: 420, width: 30, height: 20, bottom: 220 },
      {
        isCoarsePointer: false,
        innerWidth: 1440,
        innerHeight: 900,
        placement: 'below',
        containerBounds: { left: 0, right: 460, top: 40, bottom: 860 },
      },
    );
    // Clamped inside [100, 360] instead of leaking to 435
    expect(leftPanePos.left).toBe(360);
    expect(leftPanePos.placement).toBe('below');

    // 460px right split pane [980, 1440], selection near its left edge (x = 995)
    const rightPanePos = computeSelectionToolbarPosition(
      { top: 200, left: 985, width: 20, height: 20, bottom: 220 },
      {
        isCoarsePointer: false,
        innerWidth: 1440,
        innerHeight: 900,
        placement: 'below',
        containerBounds: { left: 980, right: 1440, top: 40, bottom: 860 },
      },
    );
    expect(rightPanePos.left).toBe(1080);

    // Selection near bottom of a shorter container flips to 'above' even when window is taller
    const shortContainerPos = computeSelectionToolbarPosition(
      { top: 460, left: 180, width: 80, height: 20, bottom: 480 },
      {
        isCoarsePointer: false,
        innerWidth: 1440,
        innerHeight: 900,
        placement: 'below',
        containerBounds: { left: 0, right: 460, top: 40, bottom: 500 },
      },
    );
    expect(shortContainerPos.placement).toBe('above');
    expect(shortContainerPos.top).toBe(414);
  });

  it('clamps rendered SelectionToolbar inside a 460px containerRef on a 1440px desktop viewport', () => {
    const prevWidth = window.innerWidth;
    const prevHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });

    try {
      const Host: React.FC = () => {
        const containerRef = useRef<HTMLDivElement>(null);
        const [ready, setReady] = React.useState(false);

        React.useLayoutEffect(() => {
          if (containerRef.current) {
            containerRef.current.getBoundingClientRect = () =>
              ({
                left: 0,
                right: 460,
                top: 40,
                bottom: 860,
                width: 460,
                height: 820,
                x: 0,
                y: 40,
                toJSON: () => ({}),
              }) as DOMRect;
            setReady(true);
          }
        }, []);

        return (
          <div ref={containerRef} style={{ position: 'relative' }}>
            {ready && (
              <SelectionToolbar
                selectedText="LiquidText split pane"
                selectionRect={{ top: 200, left: 420, width: 30, height: 20, bottom: 220 }}
                isVisible
                containerRef={containerRef}
                onClear={() => {}}
                onExplain={() => {}}
                onTranslate={() => {}}
                onSaveAsNote={() => {}}
                placement="below"
                hideUnavailableActions
              />
            )}
          </div>
        );
      };

      const { container } = render(<Host />);
      const toolbar = container.querySelector<HTMLElement>('[data-selection-toolbar]');
      expect(toolbar).not.toBeNull();
      expect(toolbar?.style.maxWidth).toBe('452px');
      const leftPx = Number.parseFloat(toolbar?.style.left ?? 'NaN');
      expect(Number.isFinite(leftPx)).toBe(true);
      expect(leftPx).toBeGreaterThanOrEqual(4);
      // With default fallback width 200px, left + 200 <= 456 (inside 460px container)
      expect(leftPx + 200).toBeLessThanOrEqual(456);
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: prevWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: prevHeight });
    }
  });

  it('defines container-type: inline-size and @container (max-width: 540px) overlay sidebar + compact toolbar rules in enhanced-pdf.css', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'src/features/pdf/styles/enhanced-pdf.css'),
      'utf8',
    );
    expect(css).toMatch(/\.ds-pdf-viewer\s*\{[\s\S]*?container-type:\s*inline-size;/);
    const blockStart = css.indexOf('@container (max-width: 540px)');
    expect(blockStart).toBeGreaterThan(-1);
    const block = css.slice(blockStart, css.indexOf('@container (max-width: 440px)', blockStart));
    expect(block).toContain('.ds-pdf__sidebar');
    expect(block).toContain('position: absolute');
    expect(block).toContain('.ds-pdf__sidebar--open');
    expect(block).toContain('.ds-pdf__toolbar');
    expect(block).toContain('.ds-toolbar-divider');
  });
});
