import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  notifyWorkbenchGestureFrame,
  resetWorkbenchGestureFollowerStateForTests,
  subscribeWorkbenchGestureFrames,
} from '../workbenchGestureFollowers';

function windowWithAnchor(windowId: string): HTMLElement {
  const shell = document.createElement('div');
  shell.setAttribute('data-wb-window-id', windowId);
  const anchor = document.createElement('button');
  shell.appendChild(anchor);
  document.body.appendChild(shell);
  return anchor;
}

describe('workbench gesture followers', () => {
  const unsubscribers: Array<() => void> = [];

  afterEach(() => {
    unsubscribers.splice(0).forEach((stop) => stop());
    resetWorkbenchGestureFollowerStateForTests();
    document.body.innerHTML = '';
  });

  it('only moves overlays anchored in the window being dragged', () => {
    const inA = windowWithAnchor('win-a');
    const inB = windowWithAnchor('win-b');
    const followA = vi.fn();
    const followB = vi.fn();
    unsubscribers.push(subscribeWorkbenchGestureFrames(followA, () => inA));
    unsubscribers.push(subscribeWorkbenchGestureFrames(followB, () => inB));

    notifyWorkbenchGestureFrame({ phase: 'drag', x: 12, y: -4, windowId: 'win-a' });
    notifyWorkbenchGestureFrame({ phase: 'release', x: 12, y: -4, windowId: 'win-a' });

    expect(followA).toHaveBeenCalledTimes(2);
    expect(followA).toHaveBeenNthCalledWith(1, { phase: 'drag', x: 12, y: -4, windowId: 'win-a' });
    expect(followB).not.toHaveBeenCalled();
  });

  it('skips overlays whose anchor is gone or outside any window', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    const detached = vi.fn();
    const classic = vi.fn();
    unsubscribers.push(subscribeWorkbenchGestureFrames(detached, () => null));
    unsubscribers.push(subscribeWorkbenchGestureFrames(classic, () => outside));

    notifyWorkbenchGestureFrame({ phase: 'drag', x: 5, y: 5, windowId: 'win-a' });

    expect(detached).not.toHaveBeenCalled();
    expect(classic).not.toHaveBeenCalled();
  });

  it('keeps unscoped followers and unscoped signals broadcasting', () => {
    const inB = windowWithAnchor('win-b');
    const unscoped = vi.fn();
    const scoped = vi.fn();
    unsubscribers.push(subscribeWorkbenchGestureFrames(unscoped));
    unsubscribers.push(subscribeWorkbenchGestureFrames(scoped, () => inB));

    notifyWorkbenchGestureFrame({ phase: 'drag', x: 1, y: 1, windowId: 'win-a' });
    notifyWorkbenchGestureFrame({ phase: 'release', x: 0, y: 0 });

    expect(unscoped).toHaveBeenCalledTimes(2);
    expect(scoped).toHaveBeenCalledTimes(1);
    expect(scoped).toHaveBeenCalledWith({ phase: 'release', x: 0, y: 0 });
  });
});
