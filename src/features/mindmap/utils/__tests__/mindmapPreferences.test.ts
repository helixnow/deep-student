import { beforeEach, describe, expect, it } from 'vitest';
import {
  findSpatialMindMapNeighbor,
  getMindMapPreferences,
  setMindMapPreferences,
} from '../mindmapPreferences';

function rect(left: number, top: number, width = 40, height = 20): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

describe('mindmap preferences', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to the documented Deep Student keymap', () => {
    expect(getMindMapPreferences()).toEqual({
      keymap: 'deep-student',
      canvasNavigation: 'document',
      descriptionPreview: 'full',
    });
  });

  it('persists the Mubu keymap and UX toggles together', () => {
    setMindMapPreferences({
      keymap: 'mubu',
      canvasNavigation: 'spatial',
      descriptionPreview: 'first-line',
    });
    expect(getMindMapPreferences()).toEqual({
      keymap: 'mubu',
      canvasNavigation: 'spatial',
      descriptionPreview: 'first-line',
    });
  });
});

describe('spatial canvas navigation', () => {
  it('prefers a well-aligned neighbor over a diagonally distant node', () => {
    const next = findSpatialMindMapNeighbor(rect(100, 100), [
      { id: 'aligned', rect: rect(100, 180) },
      { id: 'diagonal', rect: rect(260, 150) },
      { id: 'above', rect: rect(100, 20) },
    ], 'down');
    expect(next).toBe('aligned');
  });

  it('returns null when no node exists in the requested half-plane', () => {
    expect(findSpatialMindMapNeighbor(rect(100, 100), [
      { id: 'left', rect: rect(10, 100) },
    ], 'right')).toBeNull();
  });
});
