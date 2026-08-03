import { describe, expect, it } from 'vitest';
import { handleShellScrollEvent } from '../../src/hooks/useShellScrollGuard';

function scrollEventFor(target: EventTarget): Event {
  const event = new Event('scroll');
  Object.defineProperty(event, 'target', { value: target });
  return event;
}

describe('shell scroll guard', () => {
  it('resets accidental scrolling on the React root', () => {
    const root = document.createElement('div');
    root.id = 'root';
    root.scrollTop = 320;
    root.scrollLeft = 40;

    handleShellScrollEvent(scrollEventFor(root));

    expect(root.scrollTop).toBe(0);
    expect(root.scrollLeft).toBe(0);
  });

  it('resets accidental scrolling on the desktop workspace', () => {
    const workspace = document.createElement('div');
    workspace.dataset.shellLayer = 'workspace';
    workspace.scrollTop = 180;

    handleShellScrollEvent(scrollEventFor(workspace));

    expect(workspace.scrollTop).toBe(0);
  });

  it('leaves normal business scroll containers untouched', () => {
    const list = document.createElement('div');
    list.className = 'virtualized-list';
    list.scrollTop = 90;

    handleShellScrollEvent(scrollEventFor(list));

    expect(list.scrollTop).toBe(90);
  });
});
