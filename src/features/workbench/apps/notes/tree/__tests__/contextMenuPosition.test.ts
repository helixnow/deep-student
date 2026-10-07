import { describe, expect, it } from 'vitest';
import { clampMenuPosition } from '../TreeContextMenu';

const viewport = { width: 1112, height: 773 };
const menu = { width: 168, height: 280 };

describe('clampMenuPosition (notes tree context menu)', () => {
  it('keeps the pointer position when the menu fits', () => {
    expect(clampMenuPosition(100, 200, menu, viewport)).toEqual({ left: 100, top: 200 });
  });

  it('flips above the pointer when a low row would push the menu past the bottom edge', () => {
    expect(clampMenuPosition(100, 735, menu, viewport)).toEqual({ left: 100, top: 455 });
  });

  it('pins to the bottom edge when there is no room above either', () => {
    expect(clampMenuPosition(100, 200, { width: 168, height: 700 }, { width: 1112, height: 760 }))
      .toEqual({ left: 100, top: 52 });
  });

  it('shifts left when opened near the right edge', () => {
    expect(clampMenuPosition(1050, 100, menu, viewport).left).toBe(1112 - 8 - 168);
  });
});
