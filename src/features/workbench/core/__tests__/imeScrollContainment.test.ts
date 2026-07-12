import { afterEach, describe, expect, it, vi } from 'vitest';
import { installImeScrollContainment } from '../imeScrollContainment';

describe('installImeScrollContainment', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('restores hidden structural ancestors without resetting the real scroll viewport', () => {
    let windowX = 2;
    let windowY = 5;
    vi.spyOn(window, 'scrollX', 'get').mockImplementation(() => windowX);
    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => windowY);
    vi.spyOn(window, 'scrollTo').mockImplementation((x, y) => {
      windowX = Number(x);
      windowY = Number(y);
    });
    const root = document.createElement('div');
    const shell = document.createElement('div');
    const viewport = document.createElement('div');
    const input = document.createElement('textarea');
    root.style.overflow = 'hidden';
    shell.className = 'wb-window';
    shell.style.overflow = 'hidden';
    viewport.style.overflowX = 'hidden';
    viewport.style.overflowY = 'auto';
    viewport.append(input);
    shell.append(viewport);
    root.append(shell);
    document.body.append(root);

    root.scrollTop = 3;
    shell.scrollTop = 7;
    viewport.scrollTop = 11;
    const dispose = installImeScrollContainment(root);

    expect(root.scrollTop).toBe(0);
    expect(shell.scrollTop).toBe(0);
    expect(viewport.scrollTop).toBe(11);

    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    root.scrollTop = 30;
    shell.scrollTop = 70;
    viewport.scrollTop = 110;
    viewport.scrollLeft = 12;
    windowX = 20;
    windowY = 50;
    shell.dispatchEvent(new Event('scroll'));

    expect(root.scrollTop).toBe(0);
    expect(shell.scrollTop).toBe(0);
    expect(viewport.scrollTop).toBe(110);
    expect(viewport.scrollLeft).toBe(0);
    expect(windowX).toBe(2);
    expect(windowY).toBe(5);
    dispose();
  });
});
