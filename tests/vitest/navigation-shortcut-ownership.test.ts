import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useNavigationShortcuts } from '@/hooks/useNavigationShortcuts';

afterEach(cleanup);

function keyboard(options: KeyboardEventInit = {}) {
  return new KeyboardEvent('keydown', {
    key: 'ArrowLeft', altKey: true, bubbles: true, cancelable: true, ...options,
  });
}

function setup() {
  const onBack = vi.fn();
  const onForward = vi.fn();
  renderHook(() => useNavigationShortcuts({ onBack, onForward, canGoBack: true, canGoForward: true }));
  return { onBack, onForward };
}

describe('navigation shortcut ownership', () => {
  it('handles a keyboard event once with two mounted listeners', () => {
    const first = setup();
    const second = setup();
    window.dispatchEvent(keyboard());
    expect(first.onBack.mock.calls.length + second.onBack.mock.calls.length).toBe(1);
  });

  it('handles a mouse side button once with two mounted listeners', () => {
    const first = setup();
    const second = setup();
    window.dispatchEvent(new MouseEvent('mousedown', { button: 3, cancelable: true }));
    expect(first.onBack.mock.calls.length + second.onBack.mock.calls.length).toBe(1);
  });

  it.each([{ isComposing: true }, { keyCode: 229 }, { repeat: true }])('ignores composition and repeated keys: %j', options => {
    const { onBack } = setup();
    window.dispatchEvent(keyboard(options));
    expect(onBack).not.toHaveBeenCalled();
  });

  it('ignores a previously handled event', () => {
    const { onBack } = setup();
    const event = keyboard();
    event.preventDefault();
    window.dispatchEvent(event);
    expect(onBack).not.toHaveBeenCalled();
  });

  it('preserves navigation keys inside a nested editable element', () => {
    const { onBack } = setup();
    const editor = document.createElement('div');
    const child = document.createElement('span');
    editor.setAttribute('contenteditable', 'true');
    editor.append(child);
    document.body.append(editor);
    try {
      child.dispatchEvent(keyboard());
      expect(onBack).not.toHaveBeenCalled();
    } finally {
      editor.remove();
    }
  });
});
