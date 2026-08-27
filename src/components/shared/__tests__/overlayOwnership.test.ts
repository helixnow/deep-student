import { describe, expect, it } from 'vitest';
import {
  createOwnedOverlayStore,
  isEventInsideOwnedOverlay,
  listOwnedOverlayOwnerIds,
  registerOwnedOverlayEntry,
  resolveEventTargetElement,
} from '../overlayOwnership';

function makePortalOverlay(): { root: HTMLElement; inner: HTMLElement; text: Text } {
  const root = document.createElement('div');
  root.setAttribute('data-app-menu-id', 'menu-1');
  const inner = document.createElement('button');
  const text = document.createTextNode('item');
  inner.appendChild(text);
  root.appendChild(inner);
  document.body.appendChild(root);
  return { root, inner, text };
}

describe('overlayOwnership pure store', () => {
  it('matches element registrations for the root, descendants and text-node targets', () => {
    const store = createOwnedOverlayStore();
    const { root, inner, text } = makePortalOverlay();
    registerOwnedOverlayEntry(store, { ownerId: 'composer', element: root });

    expect(isEventInsideOwnedOverlay(store, 'composer', root)).toBe(true);
    expect(isEventInsideOwnedOverlay(store, 'composer', inner)).toBe(true);
    // pointerdown 的 target 经常是 Text 节点，必须归一化到 parentElement
    expect(isEventInsideOwnedOverlay(store, 'composer', text)).toBe(true);
    expect(isEventInsideOwnedOverlay(store, 'composer', document.body)).toBe(false);
    root.remove();
  });

  it('matches selector registrations via closest, independent of portal position', () => {
    const store = createOwnedOverlayStore();
    const { root, inner } = makePortalOverlay();
    registerOwnedOverlayEntry(store, { ownerId: 'composer', selector: '[data-app-menu-id]' });

    expect(isEventInsideOwnedOverlay(store, 'composer', inner)).toBe(true);
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    expect(isEventInsideOwnedOverlay(store, 'composer', outside)).toBe(false);
    root.remove();
    outside.remove();
  });

  it('scopes ownership per ownerId and never matches unknown owners', () => {
    const store = createOwnedOverlayStore();
    const { root, inner } = makePortalOverlay();
    registerOwnedOverlayEntry(store, { ownerId: 'composer', element: root });

    expect(isEventInsideOwnedOverlay(store, 'sidebar', inner)).toBe(false);
    expect(isEventInsideOwnedOverlay(store, 'composer', inner)).toBe(true);
    root.remove();
  });

  it('returns false for null / window-like targets and empty stores', () => {
    const store = createOwnedOverlayStore();
    expect(isEventInsideOwnedOverlay(store, 'composer', null)).toBe(false);
    registerOwnedOverlayEntry(store, { ownerId: 'composer', selector: '[data-x]' });
    expect(isEventInsideOwnedOverlay(store, 'composer', null)).toBe(false);
    expect(isEventInsideOwnedOverlay(store, 'composer', window)).toBe(false);
  });

  it('unregister is idempotent and cleans up owner buckets', () => {
    const store = createOwnedOverlayStore();
    const { root, inner } = makePortalOverlay();
    const unregisterA = registerOwnedOverlayEntry(store, { ownerId: 'composer', element: root });
    const unregisterB = registerOwnedOverlayEntry(store, { ownerId: 'composer', selector: '[data-app-menu-id]' });

    unregisterA();
    unregisterA(); // 幂等：二次调用不得误删其他登记
    expect(isEventInsideOwnedOverlay(store, 'composer', inner)).toBe(true);

    unregisterB();
    expect(isEventInsideOwnedOverlay(store, 'composer', inner)).toBe(false);
    expect(listOwnedOverlayOwnerIds(store)).toEqual([]);
    root.remove();
  });

  it('ignores registrations that provide neither element nor selector', () => {
    const store = createOwnedOverlayStore();
    const unregister = registerOwnedOverlayEntry(store, { ownerId: 'composer' });
    expect(listOwnedOverlayOwnerIds(store)).toEqual([]);
    expect(() => unregister()).not.toThrow();
  });

  it('lists distinct owner ids in registration order', () => {
    const store = createOwnedOverlayStore();
    registerOwnedOverlayEntry(store, { ownerId: 'composer', selector: '[data-a]' });
    registerOwnedOverlayEntry(store, { ownerId: 'sidebar', selector: '[data-b]' });
    registerOwnedOverlayEntry(store, { ownerId: 'composer', selector: '[data-c]' });
    expect(listOwnedOverlayOwnerIds(store)).toEqual(['composer', 'sidebar']);
  });

  it('resolveEventTargetElement normalizes Element, Text and non-node targets', () => {
    const { root, inner, text } = makePortalOverlay();
    expect(resolveEventTargetElement(inner)).toBe(inner);
    expect(resolveEventTargetElement(text)).toBe(inner);
    expect(resolveEventTargetElement(null)).toBeNull();
    expect(resolveEventTargetElement(window)).toBeNull();
    root.remove();
  });
});
