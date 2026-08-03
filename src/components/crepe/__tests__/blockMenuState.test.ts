import { describe, expect, it } from 'vitest';
import {
  findCrepeBlockMenuTypeaheadIndex,
  getNextCrepeBlockMenuIndex,
  isCrepeBlockMenuDocCurrent,
  shouldDismissCrepeBlockMenuForKey,
} from '../blockMenuState';

describe('Crepe block menu state', () => {
  it('rejects actions from a stale document snapshot', () => {
    const openedDoc = {};
    expect(isCrepeBlockMenuDocCurrent(openedDoc, openedDoc)).toBe(true);
    expect(isCrepeBlockMenuDocCurrent({}, openedDoc)).toBe(false);
  });

  it('closes for Escape and document editing keys', () => {
    expect(shouldDismissCrepeBlockMenuForKey({ key: 'Escape', editorTarget: false })).toBe(true);
    expect(shouldDismissCrepeBlockMenuForKey({ key: 'a', editorTarget: true })).toBe(true);
    expect(shouldDismissCrepeBlockMenuForKey({ key: 'Backspace', editorTarget: true })).toBe(true);
    expect(shouldDismissCrepeBlockMenuForKey({ key: 'Process', editorTarget: true, isComposing: true })).toBe(true);
  });

  it('keeps the menu for navigation and shortcuts that do not edit the doc', () => {
    expect(shouldDismissCrepeBlockMenuForKey({ key: 'ArrowDown', editorTarget: true })).toBe(false);
    expect(shouldDismissCrepeBlockMenuForKey({ key: 'c', editorTarget: true, metaKey: true })).toBe(false);
    expect(shouldDismissCrepeBlockMenuForKey({ key: 'x', editorTarget: false })).toBe(false);
  });
});

describe('getNextCrepeBlockMenuIndex', () => {
  it('cycles with arrow keys and starts from the correct end', () => {
    expect(getNextCrepeBlockMenuIndex({ key: 'ArrowDown', activeIndex: -1, itemCount: 5 })).toBe(0);
    expect(getNextCrepeBlockMenuIndex({ key: 'ArrowUp', activeIndex: -1, itemCount: 5 })).toBe(4);
    expect(getNextCrepeBlockMenuIndex({ key: 'ArrowDown', activeIndex: 4, itemCount: 5 })).toBe(0);
    expect(getNextCrepeBlockMenuIndex({ key: 'ArrowUp', activeIndex: 0, itemCount: 5 })).toBe(4);
  });

  it('jumps to boundaries with Home and End', () => {
    expect(getNextCrepeBlockMenuIndex({ key: 'Home', activeIndex: 3, itemCount: 5 })).toBe(0);
    expect(getNextCrepeBlockMenuIndex({ key: 'End', activeIndex: 3, itemCount: 5 })).toBe(4);
  });

  it('returns null for non-navigation keys and empty menus', () => {
    expect(getNextCrepeBlockMenuIndex({ key: 'a', activeIndex: 0, itemCount: 5 })).toBe(null);
    expect(getNextCrepeBlockMenuIndex({ key: 'ArrowDown', activeIndex: 0, itemCount: 0 })).toBe(null);
  });
});

describe('findCrepeBlockMenuTypeaheadIndex', () => {
  const labels = ['Text', 'Heading 1', 'Heading 2', 'Quote', 'Toggle list'];

  it('matches label prefixes case-insensitively', () => {
    expect(findCrepeBlockMenuTypeaheadIndex(labels, 'q', -1)).toBe(3);
    expect(findCrepeBlockMenuTypeaheadIndex(labels, 'HEAD', -1)).toBe(1);
  });

  it('cycles from the item after the active one for repeated keys', () => {
    expect(findCrepeBlockMenuTypeaheadIndex(labels, 'h', 1)).toBe(2);
    expect(findCrepeBlockMenuTypeaheadIndex(labels, 'h', 2)).toBe(1);
  });

  it('returns null when nothing matches or the query is empty', () => {
    expect(findCrepeBlockMenuTypeaheadIndex(labels, 'zzz', -1)).toBe(null);
    expect(findCrepeBlockMenuTypeaheadIndex(labels, '  ', -1)).toBe(null);
    expect(findCrepeBlockMenuTypeaheadIndex([], 'h', -1)).toBe(null);
  });
});
