import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommonTooltip } from '../../shared/CommonTooltip';
import { OverlayCoordinatorProvider } from '../../shared/OverlayCoordinator';
import { Popover, PopoverContent, PopoverTrigger } from './Popover';

describe('Popover overlay coordination', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('suppresses trigger tooltips while the popover is open', () => {
    render(
      <OverlayCoordinatorProvider>
        <Popover>
          <CommonTooltip content="打开详情" delay={0}>
            <PopoverTrigger asChild>
              <button type="button">详情</button>
            </PopoverTrigger>
          </CommonTooltip>
          <PopoverContent>
            <div>详情内容</div>
          </PopoverContent>
        </Popover>
      </OverlayCoordinatorProvider>
    );

    const trigger = screen.getByRole('button', { name: '详情' });
    fireEvent.mouseEnter(trigger);
    expect(screen.getByRole('tooltip')).toHaveTextContent('打开详情');

    fireEvent.click(trigger);

    expect(screen.getByRole('dialog')).toHaveTextContent('详情内容');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    fireEvent.mouseEnter(trigger);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('forwards the rendered content element ref', () => {
    const contentRef = React.createRef<HTMLDivElement>();

    render(
      <OverlayCoordinatorProvider>
        <Popover open>
          <PopoverTrigger asChild>
            <button type="button">详情</button>
          </PopoverTrigger>
          <PopoverContent ref={contentRef}>详情内容</PopoverContent>
        </Popover>
      </OverlayCoordinatorProvider>,
    );

    expect(contentRef.current).toBe(screen.getByRole('dialog'));
  });

  it('repositions an open top popover when its content height changes', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);

    let contentHeight = 100;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this.getAttribute('role') === 'dialog') {
        return {
          x: 0,
          y: 0,
          top: 0,
          right: 240,
          bottom: contentHeight,
          left: 0,
          width: 240,
          height: contentHeight,
          toJSON: () => ({}),
        } as DOMRect;
      }
      if (this.classList.contains('relative')) {
        return {
          x: 300,
          y: 500,
          top: 500,
          right: 340,
          bottom: 540,
          left: 300,
          width: 40,
          height: 40,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return {
        x: 0,
        y: 0,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      } as DOMRect;
    });

    render(
      <OverlayCoordinatorProvider>
        <Popover open>
          <PopoverTrigger asChild>
            <button type="button">详情</button>
          </PopoverTrigger>
          <PopoverContent side="top">详情内容</PopoverContent>
        </Popover>
      </OverlayCoordinatorProvider>,
    );

    await waitFor(() => expect(resizeCallbacks).toHaveLength(1));
    act(() => resizeCallbacks[0]([], {} as ResizeObserver));
    expect(screen.getByRole('dialog')).toHaveStyle({ top: '392px' });

    contentHeight = 250;
    act(() => resizeCallbacks[0]([], {} as ResizeObserver));
    expect(screen.getByRole('dialog')).toHaveStyle({ top: '242px' });
  });
});
