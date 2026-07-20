import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DesktopSidebarResizeHandle } from '../DesktopSidebarResizeHandle';

class TestPointerEvent extends MouseEvent {
  pointerId: number;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
  }
}

Object.defineProperty(window, 'PointerEvent', {
  configurable: true,
  value: TestPointerEvent,
});

describe('DesktopSidebarResizeHandle', () => {
  it('reports live pointer movement and the final pointer position', () => {
    const onResizeStart = vi.fn();
    const onResize = vi.fn();
    const onResizeEnd = vi.fn();

    render(
      <DesktopSidebarResizeHandle
        label="调整侧边栏宽度"
        width={300}
        minWidth={220}
        maxWidth={480}
        onResizeStart={onResizeStart}
        onResize={onResize}
        onResizeEnd={onResizeEnd}
      />
    );

    const separator = screen.getByRole('separator', { name: '调整侧边栏宽度' });
    fireEvent.pointerDown(separator, { pointerId: 7, clientX: 300, button: 0 });
    fireEvent.pointerMove(separator, { pointerId: 7, clientX: 344 });
    fireEvent.pointerUp(separator, { pointerId: 7, clientX: 352 });

    expect(onResizeStart).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledWith(344);
    expect(onResizeEnd).toHaveBeenCalledWith(352);
  });

  it('supports keyboard resizing and exposes the current width', () => {
    const onResize = vi.fn();
    const onResizeEnd = vi.fn();

    render(
      <DesktopSidebarResizeHandle
        label="调整侧边栏宽度"
        width={300}
        minWidth={220}
        maxWidth={480}
        onResize={onResize}
        onResizeEnd={onResizeEnd}
      />
    );

    const separator = screen.getByRole('separator', { name: '调整侧边栏宽度' });
    expect(separator).toHaveAttribute('aria-valuenow', '300');

    fireEvent.keyDown(separator, { key: 'ArrowRight' });

    expect(onResize).toHaveBeenCalledWith(308);
    expect(onResizeEnd).toHaveBeenCalledWith(308);
  });

  it('restores the committed width when pointer interaction is cancelled', () => {
    const onResizeEnd = vi.fn();

    render(
      <DesktopSidebarResizeHandle
        label="调整侧边栏宽度"
        width={300}
        minWidth={220}
        maxWidth={480}
        onResize={vi.fn()}
        onResizeEnd={onResizeEnd}
      />
    );

    const separator = screen.getByRole('separator', { name: '调整侧边栏宽度' });
    fireEvent.pointerDown(separator, { pointerId: 9, clientX: 300, button: 0 });
    fireEvent.pointerCancel(separator, { pointerId: 9, clientX: 40 });

    expect(onResizeEnd).toHaveBeenCalledWith(300);
  });
});
