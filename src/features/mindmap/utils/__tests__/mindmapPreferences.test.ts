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

  it('migrates the legacy keymap and persists UX toggles together', () => {
    localStorage.setItem('deep-student:mindmap-preferences:v1', JSON.stringify({
      keymap: 'mubu',
      canvasNavigation: 'spatial',
      descriptionPreview: 'first-line',
    }));
    expect(getMindMapPreferences()).toEqual({
      keymap: 'classic',
      canvasNavigation: 'spatial',
      descriptionPreview: 'first-line',
    });
    // 二次读取仍须保持 classic（防止迁移后被误重置回 deep-student）
    expect(getMindMapPreferences().keymap).toBe('classic');
  });

  it('persists classic keymap across set and repeated reads', () => {
    setMindMapPreferences({ keymap: 'classic' });
    expect(getMindMapPreferences().keymap).toBe('classic');
    expect(getMindMapPreferences().keymap).toBe('classic');

    setMindMapPreferences({ keymap: 'deep-student' });
    expect(getMindMapPreferences().keymap).toBe('deep-student');
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
