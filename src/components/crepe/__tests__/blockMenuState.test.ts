import { describe, expect, it } from 'vitest';
import {
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
