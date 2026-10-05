import { describe, expect, it } from 'vitest';
import { isKeyEventFromOtherModal } from '../modalKeyGuard';

function keyEventAt(target: EventTarget): Event {
  const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true });
  Object.defineProperty(event, 'target', { value: target });
  return event;
}

describe('isKeyEventFromOtherModal', () => {
  it('yields background shortcuts to keys pressed inside a modal layer', () => {
    document.body.innerHTML = `
      <main id="page"><button id="bg">bg</button></main>
      <div aria-modal="true" role="dialog"><button id="inside">in</button></div>`;
    expect(isKeyEventFromOtherModal(keyEventAt(document.getElementById('inside')!))).toBe(true);
    expect(isKeyEventFromOtherModal(keyEventAt(document.getElementById('bg')!))).toBe(false);
    expect(isKeyEventFromOtherModal(keyEventAt(window))).toBe(false);
  });

  it('does not block a listener whose own root lives in that modal', () => {
    document.body.innerHTML = `<div aria-modal="true"><section id="root"><button id="btn">x</button></section></div>`;
    const root = document.getElementById('root');
    expect(isKeyEventFromOtherModal(keyEventAt(document.getElementById('btn')!), root)).toBe(false);
  });
});
