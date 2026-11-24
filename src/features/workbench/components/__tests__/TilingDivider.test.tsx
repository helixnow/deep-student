import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useWindowStore } from '../../core/windowStore';
import { makeWin } from '../../core/__tests__/testUtils';
import { TilingDivider } from '../TilingDivider';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({ t: (k: string) => k }),
  };
});

describe('TilingDivider stacking & foreground occlusion (S5-05)', () => {
  beforeEach(() => {
    act(() => {
      useWindowStore.setState({
        windows: {},
        focusStack: [],
        tilingRatios: {},
        desktopSize: { w: 1200, h: 800 },
        transientPhases: {},
      });
    });
  });

  it('tracks pairMaxZ and enables pointer events when tiled pair is not occluded', () => {
    const left = makeWin({ id: 'left', displayMode: 'tiled-left', zIndex: 10 });
    const right = makeWin({ id: 'right', displayMode: 'tiled-right', zIndex: 14 });
    const lowerFloating = makeWin({ id: 'bg', displayMode: 'floating', zIndex: 8 });
    act(() => {
      useWindowStore.setState({
        windows: { left, right, bg: lowerFloating },
        focusStack: ['bg', 'left', 'right'],
      });
    });

    const { container } = render(<TilingDivider leftId="left" rightId="right" margin={8} />);
    const divider = container.querySelector('[data-wb-tiling-divider]') as HTMLElement;
    expect(divider).toBeTruthy();
    expect(divider.style.zIndex).toBe('14');
    expect(divider.style.pointerEvents).toBe('auto');
    expect(divider).not.toHaveAttribute('aria-hidden');
    expect(divider).toHaveAttribute('tabindex', '0');
  });

  it('drops pointer events and marks aria-hidden when a non-minimized foreground window has higher zIndex', () => {
    const left = makeWin({ id: 'left', displayMode: 'tiled-left', zIndex: 10 });
    const right = makeWin({ id: 'right', displayMode: 'tiled-right', zIndex: 12 });
    const modal = makeWin({ id: 'modal', displayMode: 'floating', zIndex: 25 });
    act(() => {
      useWindowStore.setState({
        windows: { left, right, modal },
        focusStack: ['left', 'right', 'modal'],
      });
    });

    const { container } = render(<TilingDivider leftId="left" rightId="right" margin={8} />);
    const divider = container.querySelector('[data-wb-tiling-divider]') as HTMLElement;
    expect(divider.style.zIndex).toBe('12');
    expect(Number(divider.style.zIndex)).toBeLessThan(modal.zIndex);
    expect(divider.style.pointerEvents).toBe('none');
    expect(divider).toHaveAttribute('aria-hidden', 'true');
    expect(divider).toHaveAttribute('tabindex', '-1');

    // Minimizing the foreground window restores divider interactivity
    act(() => {
      useWindowStore.setState({
        windows: { left, right, modal: { ...modal, minimized: true } },
        focusStack: ['left', 'right'],
      });
    });
    expect(divider.style.pointerEvents).toBe('auto');
    expect(divider).not.toHaveAttribute('aria-hidden');
  });

  it('disables pointer events when a non-minimized window is maximized over the tiled pair', () => {
    const left = makeWin({ id: 'left', displayMode: 'tiled-left', zIndex: 18 });
    const right = makeWin({ id: 'right', displayMode: 'tiled-right', zIndex: 20 });
    const maxed = makeWin({ id: 'maxed', displayMode: 'maximized', zIndex: 19 });
    act(() => {
      useWindowStore.setState({
        windows: { left, right, maxed },
        focusStack: ['left', 'maxed', 'right'],
      });
    });

    const { container } = render(<TilingDivider leftId="left" rightId="right" margin={8} />);
    const divider = container.querySelector('[data-wb-tiling-divider]') as HTMLElement;
    expect(divider.style.pointerEvents).toBe('none');
    expect(divider).toHaveAttribute('aria-hidden', 'true');
  });

  it('S4-12: supports Shift+Arrow keyboard resize, visible split indicator, and restore-floating action', () => {
    const left = makeWin({ id: 'left', displayMode: 'tiled-left', zIndex: 12 });
    const right = makeWin({ id: 'right', displayMode: 'tiled-right', zIndex: 14 });
    act(() => {
      useWindowStore.setState({
        windows: { left, right },
        focusStack: ['left', 'right'],
        tilingRatios: { 'left:right': 0.5 },
      });
    });

    const { container } = render(<TilingDivider leftId="left" rightId="right" margin={8} />);
    const divider = container.querySelector('[data-wb-tiling-divider]') as HTMLElement;
    expect(screen.getByTestId('wb-tiling-split-indicator')).toHaveTextContent('50%');

    fireEvent.keyDown(divider, { key: 'ArrowRight', shiftKey: true });
    expect(useWindowStore.getState().tilingRatios['left:right']).toBeCloseTo(0.58, 2);
    expect(divider).toHaveAttribute('aria-valuenow', '58');

    fireEvent.click(screen.getByTestId('wb-tiling-restore-button'));
    const state = useWindowStore.getState();
    expect(state.windows.left.displayMode).toBe('floating');
    expect(state.windows.right.displayMode).toBe('floating');
  });
});
