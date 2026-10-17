import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const layout = vi.hoisted(() => ({ scrollHeight: 400, clientHeight: 400 }));

vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ viewportRef, children, ...props }: {
    viewportRef: (element: HTMLDivElement | null) => void;
    children: React.ReactNode;
  }) => {
    const ref = React.useCallback((element: HTMLDivElement | null) => {
      if (element) {
        Object.defineProperties(element, {
          scrollHeight: { configurable: true, get: () => layout.scrollHeight },
          clientHeight: { configurable: true, get: () => layout.clientHeight },
        });
      }
      viewportRef(element);
    }, [viewportRef]);
    return <div {...props}><div ref={ref} data-testid="review-viewport">{children}</div></div>;
  },
}));
vi.mock('@/components/anki/AnkiTemplateCardFace', () => ({
  AnkiTemplateCardFace: () => <div data-testid="card-face" />,
}));

import { ReviewCardSurface } from '../review/ReviewCardSurface';
import type { UseSwipeRatingResult } from '../hooks/useSwipeRating';

class ControlledResizeObserver {
  static instances: ControlledResizeObserver[] = [];
  readonly elements = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    ControlledResizeObserver.instances.push(this);
  }
  observe = (element: Element) => { this.elements.add(element); };
  disconnect = vi.fn(() => this.elements.clear());
  unobserve = (element: Element) => { this.elements.delete(element); };
  static resize(element: Element) {
    for (const observer of this.instances) {
      if (observer.elements.has(element)) {
        observer.callback([], observer as unknown as ResizeObserver);
      }
    }
  }
}

const swipe: UseSwipeRatingResult = {
  state: { dx: 0, dy: 0, dragging: false, direction: null, progress: 0, flyout: null },
  reset: vi.fn(),
  handlers: {
    onPointerDown: vi.fn(), onPointerMove: vi.fn(), onPointerUp: vi.fn(),
    onPointerCancel: vi.fn(), onClickCapture: vi.fn(),
  },
};

function renderSurface(onFlip = vi.fn()) {
  return render(<ReviewCardSurface
    card={{ id: 'long-card', front: '奎尼丁', back: '长背面' }}
    template={null} templateLoading={false} flipped disabled={false}
    onFlip={onFlip} frontLabel="正面" backLabel="背面" flipAriaLabel="翻面"
    flipHint="点击翻面" noFrontText="无" noBackText="无"
    swipe={swipe} swipeEnabled
  />);
}

function stage(container: HTMLElement): HTMLElement {
  return container.querySelector('.wb-fc-card-stage') as HTMLElement;
}

beforeEach(() => {
  layout.scrollHeight = layout.clientHeight = 400;
  ControlledResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', ControlledResizeObserver);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe('ReviewCardSurface scroll gestures', () => {
  it('lets vertical touch scrolling take over when the iframe grows after the first measurement', () => {
    const { container } = renderSurface();
    expect(stage(container).style.touchAction).toBe('none');
    layout.scrollHeight = 1600;
    const content = container.querySelector('.wb-fc-card-content')!;
    act(() => ControlledResizeObserver.resize(content));
    expect(stage(container).style.touchAction).toBe('pan-y');

    layout.scrollHeight = 400;
    act(() => ControlledResizeObserver.resize(content));
    expect(stage(container).style.touchAction).toBe('none');
  });

  it('remeasures when the viewport changes size and disconnects the observers on unmount', () => {
    const { container, unmount } = renderSurface();
    layout.clientHeight = 200;
    act(() => ControlledResizeObserver.resize(screen.getByTestId('review-viewport')));
    expect(stage(container).style.touchAction).toBe('pan-y');
    unmount();
    expect(ControlledResizeObserver.instances.every((observer) => observer.elements.size === 0)).toBe(true);
  });

  it('does not flip when a scrollbar is clicked, but still flips on the card', () => {
    const flip = vi.fn();
    const { container } = renderSurface(flip);
    const bar = document.createElement('div');
    bar.className = 'os-scrollbar';
    const card = container.querySelector('.wb-fc-card')!;
    card.appendChild(bar);
    fireEvent.click(bar);
    expect(flip).not.toHaveBeenCalled();
    fireEvent.click(card);
    expect(flip).toHaveBeenCalledOnce();
  });
});
